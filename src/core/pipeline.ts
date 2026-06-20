import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { computeRunCost, renderCostsMarkdown } from "./costs.js";
import type { AppConfig, CharacterConfig } from "../config/schema.js";
import type { ZoneLibrary } from "../config/zones.js";
import type { Providers } from "../providers/factory.js";
import type { SceneVoice } from "../providers/video/VideoProvider.js";
import type { Workspace } from "../storage/workspace.js";
import { writeImagePromptsReport, writeTimingsReport } from "../storage/reports.js";
import { pollUntil } from "../util/poll.js";
import { createLogger } from "../util/logger.js";
import { fetchCoursePageText } from "../util/coursePage.js";
import type { CourseBrief } from "./brief.js";
import { assembleFinalVideo, resolutionDims } from "./assembler.js";
import { sceneCharacterId } from "./spec.js";
import type { BaseImageSpec, ProductionSpec, SceneSpec } from "./spec.js";
import type { BaseImage, RunManifest, SceneAudio, SceneVideo } from "./types.js";

const log = createLogger("pipeline");

/**
 * Orquestador del pipeline. No conoce proveedores concretos: recibe `Providers`.
 * Etapas: spec (Claude) | ingestSpec -> images (por base_image) -> voice -> video (HeyGen).
 * Cada etapa persiste en el workspace para poder reanudar.
 */
/** Cambios puntuales sobre UNA escena de un run existente (comando `revise`). */
export interface ReviseOptions {
  sceneId: number;
  dialogue?: string;
  /** Nuevo movimiento (convierte la escena en dinámica). */
  motion?: string;
  expressiveness?: "high" | "medium" | "low";
  /** Nueva zona del decorado (regenera la imagen de la escena). */
  zone?: string;
  /** Nuevo personaje (regenera la imagen de la escena). */
  character?: string;
  /** Convierte una dinámica en talking-head. */
  makeTalkingHead?: boolean;
  /** Re-tira la escena sin cambios (otra toma; útil para glitches de Veo). */
  reroll?: boolean;
  /** Regenera la imagen base (talking-head) aunque no cambie zona/personaje (p. ej. proporciones raras). */
  regenImage?: boolean;
}

/** Overrides de render a nivel de run (para pruebas/comparaciones). */
export interface RenderOverrides {
  /** Fuerza este expressiveness en todas las escenas (pisa el de la escena y el default). */
  expressiveness?: "high" | "medium" | "low";
  /** Omite el motion_prompt en todas las escenas (para aislar el efecto de expressiveness). */
  omitMotionPrompt?: boolean;
}

export class Pipeline {
  private charsById: Map<string, CharacterConfig>;

  constructor(
    private providers: Providers,
    private config: AppConfig,
    private workspace: Workspace,
    private overrides: RenderOverrides = {},
    private zoneLibrary: ZoneLibrary = {},
  ) {
    this.charsById = new Map(config.characters.map((c) => [c.id, c]));
  }

  /** Descripción de una zona: override del spec si lo trae, si no, la librería compartida. */
  private resolveZone(spec: ProductionSpec, zoneId?: string): string | undefined {
    if (!zoneId) return undefined;
    return spec.zones[zoneId] ?? this.zoneLibrary[zoneId];
  }

  /** Etapa A (variante 1): brief -> ProductionSpec generado por Claude. */
  async spec(brief: CourseBrief): Promise<RunManifest> {
    const characters = brief.character_ids.map((id) => this.requireChar(id));

    // Fuente principal: la ficha del curso (source_url). Si falla, se sigue con transcript/talking_points.
    let sourceText: string | undefined;
    if (brief.source_url) {
      try {
        sourceText = await fetchCoursePageText(brief.source_url);
      } catch (e) {
        log.warn(`No se pudo leer la ficha (${brief.source_url}): ${(e as Error).message}. Sigo con transcript/talking_points.`);
      }
    }
    if (!sourceText && !brief.current_transcript && brief.talking_points.length === 0) {
      throw new Error("El brief no tiene fuente: indica 'source_url' (ficha), 'current_transcript' o 'talking_points'.");
    }

    const spec = await this.providers.llm.generateSpec({
      brief,
      sourceText,
      characters,
      zones: this.zoneLibrary,
      constraints: this.config.constraints,
      aspectRatio: this.config.video.aspectRatio,
      client: this.config.client,
    });

    const manifest: RunManifest = {
      runId: this.workspace.runId,
      createdAt: new Date().toISOString(),
      source: "claude",
      brief,
      spec,
    };
    this.workspace.saveManifest(manifest);
    log.info(`Spec guardado: ${spec.scenes.length} escenas -> ${this.workspace.specPath}`);
    return manifest;
  }

  /** Etapa A (variante 2): ingerir un ProductionSpec hecho a mano (sin Claude). */
  ingestSpec(spec: ProductionSpec): RunManifest {
    // Cada escena debe referenciar un base_image válido, y cada base_image un personaje
    // que exista en config (de ahí salen voz e imagen de referencia).
    const baseIds = new Set(Object.keys(spec.base_images));
    for (const s of spec.scenes) {
      if (!baseIds.has(s.base_image)) {
        throw new Error(`La escena ${s.id} referencia un base_image inexistente: "${s.base_image}".`);
      }
    }
    for (const b of Object.values(spec.base_images)) {
      this.requireChar(b.character);
      if (b.zone && !this.resolveZone(spec, b.zone)) {
        log.warn(`Zona "${b.zone}" no está en la librería ni en el spec; la imagen saldrá sin entorno.`);
      }
    }

    const manifest: RunManifest = {
      runId: this.workspace.runId,
      createdAt: new Date().toISOString(),
      source: "ingested",
      spec,
    };
    this.workspace.saveManifest(manifest);
    log.info(
      `Spec ingerido: ${spec.scenes.length} escenas, ${Object.keys(spec.base_images).length} base_images.`,
    );
    return manifest;
  }

  /**
   * Etapa B: genera (o resuelve) cada `base_image` UNA vez y la reutiliza en sus escenas.
   * Con image="none" usa la imagen de referencia del personaje tal cual.
   */
  async images(manifest: RunManifest, limit?: number): Promise<RunManifest> {
    const spec = this.requireSpec(manifest);
    const images: BaseImage[] = manifest.images ?? [];

    // Talking-head siempre necesita base_image. Las dinámicas la necesitan SOLO si el motor usa
    // un frame inicial (fal image-to-video); con reference-to-video / heygen-shot no hace falta.
    const scenesNeedingImage = this.dynamicUsesStartFrame()
      ? pickScenes(spec, limit)
      : pickScenes(spec, limit).filter((s) => !s.motion);
    for (const baseId of uniqueBaseImageIds(scenesNeedingImage)) {
      const base = spec.base_images[baseId];
      if (!base) throw new Error(`La escena referencia un base_image inexistente: "${baseId}".`);
      const character = this.requireChar(base.character);
      const prompt = this.providers.image
        ? this.buildBaseImagePrompt(spec, base, character)
        : "(imagen de referencia del personaje, sin generación)";

      if (this.workspace.hasBaseImage(baseId)) {
        upsert(images, "baseImageId", { ...this.resolveExistingBaseImage(baseId, character), prompt });
        log.info(`base_image ${baseId}: ya existe, se omite.`);
        continue;
      }

      if (this.providers.image) {
        const t0 = process.hrtime.bigint();
        const generated = await this.providers.image.generateScene({
          prompt,
          referenceImages: [this.readReference(character)],
          aspectRatio: this.config.video.aspectRatio,
        });
        const genSeconds = round1(elapsedSeconds(t0));
        const filePath = this.workspace.saveBaseImage(baseId, generated.data);
        upsert(images, "baseImageId", {
          baseImageId: baseId,
          characterId: character.id,
          filePath,
          mimeType: generated.mimeType,
          referenceImagePath: character.referenceImagePath,
          prompt,
          genSeconds,
        });
        log.info(`base_image ${baseId} (${character.name}, ${base.zone ?? "sin zona"}): imagen generada en ${genSeconds}s.`);
      } else {
        const ref = this.readReference(character);
        const filePath = this.workspace.saveBaseImage(baseId, ref.data);
        upsert(images, "baseImageId", {
          baseImageId: baseId,
          characterId: character.id,
          filePath,
          mimeType: ref.mimeType,
          referenceImagePath: character.referenceImagePath,
          prompt,
        });
        log.info(`base_image ${baseId}: usa imagen de ${character.name} tal cual.`);
      }
      manifest.images = images;
      this.workspace.saveManifest(manifest);
    }
    manifest.images = images;
    this.workspace.saveManifest(manifest);
    const promptsPath = writeImagePromptsReport(this.workspace, spec, images);
    log.info(`Prompts de imagen -> ${promptsPath}`);
    return manifest;
  }

  /**
   * Etapa C: audio por escena. Solo aplica con providers.voice === "elevenlabs" (TTS propio).
   * En el camino por defecto (HeyGen sintetiza con voice_id) esta etapa se omite.
   */
  async voice(manifest: RunManifest, limit?: number): Promise<RunManifest> {
    if (this.config.providers.voice !== "elevenlabs" || !this.providers.voice) {
      log.info("Voz manejada por HeyGen (voice_id); se omite la etapa de audio.");
      return manifest;
    }
    const spec = this.requireSpec(manifest);
    const audio: SceneAudio[] = manifest.audio ?? [];

    for (const scene of pickScenes(spec, limit)) {
      if (this.workspace.hasAudio(scene.id)) {
        upsert(audio, "sceneId", { sceneId: scene.id, filePath: this.workspace.audioPath(scene.id) });
        log.info(`Escena ${scene.id}: audio ya existe, se omite.`);
        continue;
      }
      const character = this.requireChar(sceneCharacterId(spec, scene));
      if (!character.elevenLabs) {
        throw new Error(`Personaje "${character.id}" sin config 'elevenLabs' para providers.voice="elevenlabs".`);
      }
      const result = await this.providers.voice.synthesize({
        text: scene.dialogue,
        voiceId: character.elevenLabs.voiceId,
        params: character.elevenLabs.params,
        language: spec.video.language,
      });
      const filePath = this.workspace.saveAudio(scene.id, result.data);
      upsert(audio, "sceneId", { sceneId: scene.id, filePath });
      log.info(`Escena ${scene.id}: audio generado.`);

      manifest.audio = audio;
      this.workspace.saveManifest(manifest);
    }
    manifest.audio = audio;
    this.workspace.saveManifest(manifest);
    return manifest;
  }

  /** Etapa D: video por escena (HeyGen Avatar IV con la base_image + voz + motion). Idempotente. */
  async videos(manifest: RunManifest, limit?: number): Promise<RunManifest> {
    const spec = this.requireSpec(manifest);
    const scenes = pickScenes(spec, limit);
    const hasStatic = scenes.some((s) => !s.motion);
    if (hasStatic && !manifest.images?.length) throw new Error("Faltan imágenes; ejecuta 'images' primero.");
    if (this.config.providers.voice === "elevenlabs" && scenes.some((s) => !s.motion) && !manifest.audio?.length) {
      throw new Error("Falta audio; ejecuta 'voice' primero.");
    }

    const videos: SceneVideo[] = manifest.videos ?? [];

    for (const scene of scenes) {
      const existing = videos.find((v) => v.sceneId === scene.id);
      if (existing?.status === "completed") {
        log.info(`Escena ${scene.id}: video ya completado, se omite.`);
        continue;
      }
      const character = this.requireChar(sceneCharacterId(spec, scene));
      const t0 = process.hrtime.bigint();

      // Escena DINÁMICA: motor Veo reference-to-video + voice changer.
      if (scene.motion) {
        try {
          await this.renderDynamic(spec, scene, character);
          upsert(videos, "sceneId", {
            sceneId: scene.id,
            status: "completed",
            filePath: this.workspace.videoPath(scene.id),
            genSeconds: round1(elapsedSeconds(t0)),
          });
          log.info(`Escena ${scene.id}: video dinámico listo (${round1(elapsedSeconds(t0))}s).`);
        } catch (e) {
          upsert(videos, "sceneId", { sceneId: scene.id, status: "failed", error: (e as Error).message });
          log.error(`Escena ${scene.id} (dinámica): ${(e as Error).message}`);
        }
        manifest.videos = videos;
        this.workspace.saveManifest(manifest);
        continue;
      }

      try {
        const created = await this.createOrResume(scene, character, existing);
        const final = await pollUntil(
          () => this.providers.video.getStatus(created.providerJobId),
          (r) => r.status === "completed" || r.status === "failed",
          { intervalMs: 8000, timeoutMs: 15 * 60 * 1000 },
        );
        // Descarga el mp4 al workspace (las URLs de HeyGen expiran).
        let filePath: string | undefined;
        if (final.status === "completed" && final.videoUrl) {
          filePath = await this.downloadVideo(scene.id, final.videoUrl);
        }
        upsert(videos, "sceneId", {
          sceneId: scene.id,
          status: final.status,
          providerJobId: created.providerJobId,
          videoUrl: final.videoUrl,
          filePath,
          error: final.error,
          genSeconds: round1(elapsedSeconds(t0)),
        });
        log.info(
          final.status === "completed"
            ? `Escena ${scene.id}: video listo -> ${filePath ?? final.videoUrl}`
            : `Escena ${scene.id}: video ${final.status}${final.error ? ` (${final.error})` : ""}`,
        );
      } catch (e) {
        upsert(videos, "sceneId", { sceneId: scene.id, status: "failed", error: (e as Error).message });
        log.error(`Escena ${scene.id}: ${(e as Error).message}`);
      }
      manifest.videos = videos;
      this.workspace.saveManifest(manifest);
    }
    manifest.videos = videos;
    this.workspace.saveManifest(manifest);
    const { path } = writeTimingsReport(this.workspace, spec, manifest.images ?? [], videos);
    log.info(`Tiempos -> ${path}`);
    return manifest;
  }

  /**
   * Etapa D: une todas las escenas completadas en un solo mp4 (normaliza resolución/fps + concat).
   * Devuelve la ruta del video final, o null si no hay nada que montar.
   */
  async assemble(manifest: RunManifest): Promise<string | null> {
    const completed = (manifest.videos ?? []).filter((v) => v.status === "completed");
    if (completed.length === 0) {
      log.warn("Montaje omitido: no hay escenas completadas.");
      return null;
    }
    const expected = manifest.spec?.scenes.length ?? completed.length;
    if (completed.length < expected) {
      const done = new Set(completed.map((v) => v.sceneId));
      const missing = (manifest.spec?.scenes ?? []).map((s) => s.id).filter((id) => !done.has(id));
      log.warn(`Montaje parcial: faltan escenas [${missing.join(", ")}]; se unen solo las ${completed.length} listas.`);
    }
    const clips = [...completed]
      .sort((a, b) => a.sceneId - b.sceneId)
      .map((v) => v.filePath ?? this.workspace.videoPath(v.sceneId));
    const [width, height] = resolutionDims(this.config.video.resolution);
    const outPath = join(this.workspace.root, `${slugify(this.config.client)}-final-${this.config.video.resolution}.mp4`);
    log.info(`Montando ${clips.length} escenas en ${width}x${height} -> ${outPath}`);
    await assembleFinalVideo({ clips, outPath, width, height });
    manifest.finalVideo = outPath;
    // Estimación de coste de generación (API): se cachea en el manifest y se escribe costs.md.
    const cost = computeRunCost(manifest, this.config);
    manifest.costEstimate = cost;
    writeFileSync(join(this.workspace.root, "costs.md"), renderCostsMarkdown(this.workspace.runId, cost), "utf8");
    log.info(`Coste estimado (generación API): $${cost.total.toFixed(2)} -> costs.md`);
    this.workspace.saveManifest(manifest);
    return outPath;
  }

  /**
   * Cambia UNA escena de un run y re-renderiza solo lo afectado, reusando el resto:
   * parchea `manifest.spec`, invalida (vídeo, y la imagen si cambió zona/personaje o pasó a TH),
   * y re-ejecuta images -> voice -> videos -> assemble (todas son idempotentes). Devuelve el final.
   */
  async revise(manifest: RunManifest, opts: ReviseOptions): Promise<string | null> {
    const spec = this.requireSpec(manifest);
    const scene = spec.scenes.find((s) => s.id === opts.sceneId);
    if (!scene) throw new Error(`No existe la escena ${opts.sceneId} en el run.`);

    const changed =
      opts.dialogue != null || opts.motion != null || opts.expressiveness != null ||
      opts.zone != null || opts.character != null || opts.makeTalkingHead || opts.reroll || opts.regenImage;
    if (!changed) throw new Error("revise: indica al menos un cambio (--dialogue/--motion/--zone/--character/--expressiveness/--make-talking-head/--regen-image o --reroll).");

    if (opts.dialogue != null) scene.dialogue = opts.dialogue;
    if (opts.expressiveness != null) scene.expressiveness = opts.expressiveness;
    if (opts.motion != null) scene.motion = opts.motion; // pasa a dinámica
    if (opts.makeTalkingHead) delete scene.motion;

    let imageAffected = Boolean(opts.makeTalkingHead) || Boolean(opts.regenImage);
    if (opts.zone != null || opts.character != null) {
      if (opts.character != null && !this.charsById.has(opts.character)) {
        throw new Error(`Personaje "${opts.character}" no está en config.characters.`);
      }
      if (opts.zone != null && !this.resolveZone(spec, opts.zone)) {
        throw new Error(`La zona "${opts.zone}" no existe en la librería (zones.json) ni en el spec.`);
      }
      const baseId = scene.base_image;
      const base = spec.base_images[baseId];
      if (!base) throw new Error(`La escena ${scene.id} referencia un base_image inexistente.`);
      // Si la toma se comparte con otras escenas, la separamos para no afectarlas.
      const shared = spec.scenes.some((s) => s.base_image === baseId && s.id !== scene.id);
      let target = base;
      if (shared) {
        const newId = nextBaseImageId(spec.base_images);
        target = { character: base.character, zone: base.zone, framing: base.framing, used_in_scenes: [scene.id] };
        spec.base_images[newId] = target;
        base.used_in_scenes = base.used_in_scenes.filter((id) => id !== scene.id);
        scene.base_image = newId;
        log.info(`Escena ${scene.id}: base_image separado en ${newId} (no afecta a las demás).`);
      }
      if (opts.zone != null) target.zone = opts.zone;
      if (opts.character != null) target.character = opts.character;
      imageAffected = true;
    }

    // Invalidar la escena: quitar su vídeo del manifest + borrar los mp4.
    manifest.videos = (manifest.videos ?? []).filter((v) => v.sceneId !== scene.id);
    for (const p of [this.workspace.videoPath(scene.id), this.workspace.videoPath(scene.id).replace(/\.mp4$/, ".veo-raw.mp4")]) {
      if (existsSync(p)) unlinkSync(p);
    }
    // Si cambió la imagen y la escena es talking-head, borrar su imagen base para regenerarla.
    if (imageAffected && !scene.motion && existsSync(this.workspace.baseImagePath(scene.base_image))) {
      unlinkSync(this.workspace.baseImagePath(scene.base_image));
    }
    this.workspace.saveManifest(manifest);
    log.info(`Escena ${scene.id} invalidada; re-renderizando solo lo afectado...`);

    // Re-ejecutar lo necesario (idempotente: salta lo ya hecho).
    // Talking-head necesita imagen; dinámicas también si el motor usa frame inicial (image-to-video).
    if (!scene.motion || this.dynamicUsesStartFrame()) manifest = await this.images(manifest);
    manifest = await this.voice(manifest);
    manifest = await this.videos(manifest);
    return this.assemble(manifest);
  }

  // --- helpers ---

  private async createOrResume(
    scene: SceneSpec,
    character: CharacterConfig,
    existing: SceneVideo | undefined,
  ): Promise<{ providerJobId: string }> {
    if (existing?.providerJobId && existing.status === "processing") {
      log.info(`Escena ${scene.id}: reanudando job ${existing.providerJobId}.`);
      return { providerJobId: existing.providerJobId };
    }
    if (!this.workspace.hasBaseImage(scene.base_image)) {
      throw new Error(`Falta la imagen base "${scene.base_image}"; ejecuta 'images' primero.`);
    }
    const image = readFileSync(this.workspace.baseImagePath(scene.base_image));
    const result = await this.providers.video.createSceneVideo({
      image,
      imageMimeType: sniffImageMime(image),
      voice: this.buildVoice(scene, character),
      motionPrompt: this.overrides.omitMotionPrompt ? undefined : scene.motion_prompt,
      expressiveness:
        this.overrides.expressiveness ?? scene.expressiveness ?? this.config.video.defaultExpressiveness,
      aspectRatio: this.config.video.aspectRatio,
      resolution: this.config.video.resolution,
      useAvatarIV: this.config.video.useAvatarIV,
    });
    return { providerJobId: result.providerJobId };
  }

  /** Descarga el mp4 final al workspace. Si falla, no rompe el run (queda la URL). */
  private async downloadVideo(sceneId: number, url: string): Promise<string | undefined> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return this.workspace.saveVideo(sceneId, buf);
    } catch (e) {
      log.warn(`Escena ${sceneId}: no se pudo descargar el mp4 (${(e as Error).message}); queda la URL.`);
      return undefined;
    }
  }

  /** Construye la voz de la escena: texto+voice_id (HeyGen) o audio propio (ElevenLabs). */
  private buildVoice(scene: SceneSpec, character: CharacterConfig): SceneVoice {
    if (this.config.providers.voice === "elevenlabs") {
      return { kind: "audio", data: readFileSync(this.workspace.audioPath(scene.id)), mimeType: "audio/mpeg" };
    }
    if (!character.heygenVoiceId) {
      throw new Error(`Personaje "${character.id}" sin heygenVoiceId (requerido para providers.voice="heygen").`);
    }
    return { kind: "text", text: scene.dialogue, voiceId: character.heygenVoiceId };
  }

  /** ¿El motor dinámico parte de un frame inicial (fal image-to-video)? → las dinámicas necesitan base_image. */
  private dynamicUsesStartFrame(): boolean {
    const d = this.config.video.dynamic;
    return d.provider === "fal" && d.falModel.includes("image-to-video");
  }

  /** Renderiza una escena dinámica: Veo (reference- o image-to-video) + voice changer + mux. */
  private async renderDynamic(spec: ProductionSpec, scene: SceneSpec, character: CharacterConfig): Promise<void> {
    if (!this.providers.dynamic) {
      throw new Error("Escena dinámica pero el motor dinámico no está disponible (faltan credenciales del provider configurado).");
    }

    // HeyGen Shots: voz nativa del look, prompt cinematográfico (regla cara-a-cámara), sin STS.
    if (this.config.video.dynamic.provider === "heygen-shot") {
      if (!character.heygenLookId) {
        throw new Error(`Personaje "${character.id}" sin heygenLookId (requerido para video.dynamic.provider="heygen-shot").`);
      }
      await this.providers.dynamic.generate({
        prompt: this.buildShotPrompt(spec, scene, character),
        heygenLookId: character.heygenLookId,
        aspectRatio: this.config.video.aspectRatio,
        outputPath: this.workspace.videoPath(scene.id),
      });
      return;
    }

    // Veo (gemini/fal): reference-to-video o image-to-video + voice changer (ElevenLabs STS).
    if (!character.elevenLabs?.voiceId) {
      throw new Error(`Personaje "${character.id}" sin elevenLabs.voiceId (requerido para el voice changer de escenas dinámicas).`);
    }
    // image-to-video: el frame inicial es la imagen base de la escena (avatar ya en la zona);
    // reference-to-video: el retrato del personaje (asset de identidad).
    let img: { data: Buffer; mimeType: string };
    if (this.dynamicUsesStartFrame() && this.workspace.hasBaseImage(scene.base_image)) {
      img = { data: readFileSync(this.workspace.baseImagePath(scene.base_image)), mimeType: "image/png" };
    } else {
      img = this.readReference(character);
    }
    await this.providers.dynamic.generate({
      referenceImage: img.data,
      referenceMimeType: img.mimeType,
      prompt: this.buildDynamicPrompt(spec, scene, character),
      voiceId: character.elevenLabs.voiceId,
      voiceSettings: character.elevenLabs.params,
      aspectRatio: this.config.video.aspectRatio,
      outputPath: this.workspace.videoPath(scene.id),
    });
  }

  /**
   * Prompt para HeyGen Cinematic Avatar (Shots). Regla de oro: el avatar MIRA A CÁMARA mientras
   * habla (camina HACIA la cámara / cámara de frente en movimiento), nunca de perfil al hablar.
   */
  private buildShotPrompt(spec: ProductionSpec, scene: SceneSpec, character: CharacterConfig): string {
    const base = spec.base_images[scene.base_image];
    const zone = base ? this.resolveZone(spec, base.zone) : undefined;
    const lang = (spec.video.language ?? "").toLowerCase().startsWith("es")
      ? "Spanish (Spain accent)"
      : spec.video.language || "the target language";
    const who = [character.ageRange ? `${character.ageRange}-year-old` : "", character.gender ?? "person"].filter(Boolean).join(" ");
    const { subj } = genderPronouns(character.gender);
    const motion = scene.motion ?? "with a gentle slow push-in";
    return [
      `A ${who}${character.wardrobe ? ` in ${character.wardrobe}` : ""} ${motion}, looking directly into the camera and speaking the whole time.`,
      `Keep the face TO CAMERA (front-facing) while talking; if there is movement, the person walks TOWARD the camera or the camera moves in front of them (dolly/push-in/slow arc) — never a side/profile shot while speaking.`,
      zone ? `Setting: ${zone}.` : "",
      `${subj} says, in ${lang}: "${scene.dialogue}"`,
      `Mouth in sync with the speech at all times. Lively background with people when the setting includes them, light natural depth of field (no heavy blur).`,
      `Cinematic corporate promo, realistic, ${this.config.video.aspectRatio}, smooth professional camera motion. Do NOT render any on-screen text, captions, subtitles or graphics.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  /** Prompt de Veo para una escena dinámica: movimiento + apariencia + entorno + diálogo. */
  private buildDynamicPrompt(spec: ProductionSpec, scene: SceneSpec, character: CharacterConfig): string {
    const base = spec.base_images[scene.base_image];
    const zone = base ? this.resolveZone(spec, base.zone) : undefined;
    const lang = (spec.video.language ?? "").toLowerCase().startsWith("es")
      ? "Spanish (Spain accent)"
      : spec.video.language || "the target language";
    const { subj, poss } = genderPronouns(character.gender);
    // Zonas de estudio/CTA (fondo limpio para logo en post) no llevan compañeros.
    const isStudio = /studio|backdrop|logo/i.test(zone ?? "");
    const bgClause = isStudio
      ? `Background clean and premium with only a LIGHT, natural depth of field — avoid heavy lens blur or bokeh. Keep the backdrop plain (no on-screen logo); do NOT add coworkers or office props.`
      : `Background clearly visible and recognizable with only a LIGHT, natural depth of field — avoid heavy lens blur or bokeh. Keep the office lively with real coworkers working when the setting includes them (not empty or cold).`;
    return [
      `The person from the reference image ${scene.motion}, speaking directly to the camera.`,
      `Keep ${poss} exact face, hair and appearance${character.wardrobe ? ` (${character.wardrobe})` : ""}.`,
      zone ? `Setting: ${zone}.` : "",
      `${subj} says, in ${lang}: "${scene.dialogue}"`,
      bgClause,
      `Cinematic corporate promo, realistic, ${this.config.video.aspectRatio}, smooth motion.`,
      `Do NOT render any on-screen text, captions, subtitles, numbers or graphics.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  /**
   * Prompt de texto de una base_image. NO describe la cara: la apariencia del avatar viene
   * de la imagen de referencia que se adjunta aparte (config.referenceImagePath del personaje).
   */
  private buildBaseImagePrompt(spec: ProductionSpec, base: BaseImageSpec, character: CharacterConfig): string {
    const zone = this.resolveZone(spec, base.zone);
    return [
      "Coloca a la persona de la imagen de referencia adjunta como el avatar protagonista de la escena.",
      "Mantén EXACTAMENTE su rostro, peinado y rasgos; no cambies su identidad.",
      zone ? `Entorno: ${zone}.` : "",
      character.wardrobe ? `Vestuario: ${character.wardrobe}.` : "",
      // Si la escena define un encuadre propio, se respeta (no se fuerza el plano de frente).
      base.framing
        ? `Encuadre: ${base.framing}. Mantén proporciones humanas naturales (cabeza proporcional al cuerpo).`
        : "Encuádralo en plano medio (del pecho hacia arriba), erguido y de frente a cámara, con proporciones humanas naturales (cabeza proporcional al cuerpo). Manos relajadas y libres, sin sostener objetos.",
      "Profundidad de campo LIGERA y natural: el fondo se ve NÍTIDO y reconocible (NADA de desenfoque fuerte de lente). Si la zona incluye gente, que se note un ambiente VIVO y activo (oficina con compañeros trabajando), no vacío ni frío.",
      `Intégralo de forma realista en el entorno. Composición horizontal ${this.config.video.aspectRatio}, avatar a cámara.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private resolveExistingBaseImage(baseId: string, character: CharacterConfig): BaseImage {
    return {
      baseImageId: baseId,
      characterId: character.id,
      filePath: this.workspace.baseImagePath(baseId),
      mimeType: this.providers.image ? "image/jpeg" : mimeFromPath(character.referenceImagePath),
      referenceImagePath: character.referenceImagePath,
    };
  }

  private readReference(character: CharacterConfig): { data: Buffer; mimeType: string } {
    let data: Buffer;
    try {
      data = readFileSync(character.referenceImagePath);
    } catch {
      throw new Error(
        `No se pudo leer la imagen de referencia de "${character.id}": ${character.referenceImagePath}`,
      );
    }
    return { data, mimeType: mimeFromPath(character.referenceImagePath) };
  }

  private requireChar(id: string): CharacterConfig {
    const c = this.charsById.get(id);
    if (!c) throw new Error(`Personaje "${id}" no está en config.characters.`);
    return c;
  }

  private requireSpec(manifest: RunManifest): ProductionSpec {
    if (!manifest.spec) throw new Error("No hay spec; ejecuta 'spec'/'generate'/'ingest' primero.");
    return manifest.spec;
  }
}

/** Pronombres en inglés según el género del personaje (para los prompts de video). */
function genderPronouns(gender?: string): { subj: string; poss: string } {
  const g = (gender ?? "").toLowerCase();
  if (g.startsWith("f") || g.includes("muj") || g.includes("femen")) return { subj: "She", poss: "her" };
  if (g.startsWith("m") || g.includes("hombre") || g.includes("masc")) return { subj: "He", poss: "his" };
  return { subj: "The person", poss: "their" };
}

function nextBaseImageId(images: Record<string, unknown>): string {
  const nums = Object.keys(images)
    .map((k) => /^IMG_(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m != null)
    .map((m) => parseInt(m[1]!, 10));
  return `IMG_${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "video"
  );
}

function elapsedSeconds(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e9;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Subconjunto de escenas a procesar (para pruebas acotadas con --limit). */
function pickScenes(spec: ProductionSpec, limit?: number) {
  return limit && limit > 0 ? spec.scenes.slice(0, limit) : spec.scenes;
}

/** Ids de base_image únicos referenciados por un conjunto de escenas, en orden de aparición. */
function uniqueBaseImageIds(scenes: SceneSpec[]): string[] {
  return [...new Set(scenes.map((s) => s.base_image))];
}

function mimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

/** Detecta el MIME real por los bytes (magic numbers); robusto ante extensión incorrecta. */
function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/png";
}

function upsert<T extends Record<K, string | number>, K extends string>(list: T[], key: K, item: T): void {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i >= 0) list[i] = item;
  else list.push(item);
}
