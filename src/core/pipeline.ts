import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { AppConfig, CharacterConfig } from "../config/schema.js";
import type { ZoneLibrary } from "../config/zones.js";
import type { Providers } from "../providers/factory.js";
import type { SceneVoice } from "../providers/video/VideoProvider.js";
import type { Workspace } from "../storage/workspace.js";
import { writeImagePromptsReport, writeTimingsReport } from "../storage/reports.js";
import { pollUntil } from "../util/poll.js";
import { createLogger } from "../util/logger.js";
import type { CourseBrief } from "./brief.js";
import { sceneCharacterId } from "./spec.js";
import type { BaseImageSpec, ProductionSpec, SceneSpec } from "./spec.js";
import type { BaseImage, RunManifest, SceneAudio, SceneVideo } from "./types.js";

const log = createLogger("pipeline");

/**
 * Orquestador del pipeline. No conoce proveedores concretos: recibe `Providers`.
 * Etapas: spec (Claude) | ingestSpec -> images (por base_image) -> voice -> video (HeyGen).
 * Cada etapa persiste en el workspace para poder reanudar.
 */
/** Overrides de render a nivel de corrida (para pruebas/comparaciones). */
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
    const spec = await this.providers.llm.generateSpec({
      brief,
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

    // Las escenas dinámicas (con motion) no usan base_image generada: Veo parte de la foto
    // de referencia del personaje. Solo generamos base_images de escenas talking-head.
    const staticScenes = pickScenes(spec, limit).filter((s) => !s.motion);
    for (const baseId of uniqueBaseImageIds(staticScenes)) {
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

  /** Descarga el mp4 final al workspace. Si falla, no rompe la corrida (queda la URL). */
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

  /** Renderiza una escena dinámica: Veo reference-to-video + voice changer + mux. */
  private async renderDynamic(spec: ProductionSpec, scene: SceneSpec, character: CharacterConfig): Promise<void> {
    if (!this.providers.dynamic) {
      throw new Error("Escena dinámica pero el motor dinámico no está disponible (faltan GOOGLE_API_KEY/ELEVENLABS_API_KEY).");
    }
    if (!character.elevenLabs?.voiceId) {
      throw new Error(`Personaje "${character.id}" sin elevenLabs.voiceId (requerido para el voice changer de escenas dinámicas).`);
    }
    const ref = this.readReference(character);
    await this.providers.dynamic.generate({
      referenceImage: ref.data,
      referenceMimeType: ref.mimeType,
      prompt: this.buildDynamicPrompt(spec, scene, character),
      voiceId: character.elevenLabs.voiceId,
      aspectRatio: this.config.video.aspectRatio,
      outputPath: this.workspace.videoPath(scene.id),
    });
  }

  /** Prompt de Veo para una escena dinámica: movimiento + apariencia + entorno + diálogo. */
  private buildDynamicPrompt(spec: ProductionSpec, scene: SceneSpec, character: CharacterConfig): string {
    const base = spec.base_images[scene.base_image];
    const zone = base ? this.resolveZone(spec, base.zone) : undefined;
    const lang = (spec.video.language ?? "").toLowerCase().startsWith("es")
      ? "Spanish (Spain accent)"
      : spec.video.language || "the target language";
    return [
      `The person from the reference image ${scene.motion}, speaking directly to the camera.`,
      `Keep her exact face, hair and appearance${character.wardrobe ? ` (${character.wardrobe})` : ""}.`,
      zone ? `Setting: ${zone}.` : "",
      `She says, in ${lang}: "${scene.dialogue}"`,
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
      base.framing ? `Encuadre: ${base.framing}.` : "",
      character.wardrobe ? `Vestuario: ${character.wardrobe}.` : "",
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
