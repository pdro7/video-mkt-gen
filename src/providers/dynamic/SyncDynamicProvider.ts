import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLogger } from "../../util/logger.js";
import { withRetry } from "../../util/retry.js";
import { FalDynamicVideoProvider } from "./FalDynamicVideoProvider.js";
import type { DynamicSceneInput } from "./BaseDynamicVideoProvider.js";

const log = createLogger("dynamic-sync");

/**
 * Motor de escenas dinámicas con lip-sync de Sync.so.
 *  1. Veo image-to-video (fal) genera el VISUAL (avatar en movimiento; su audio se descarta).
 *  2. Sync (/v2/generate) genera la voz por TTS de ElevenLabs (integrado en Sync) desde el diálogo
 *     y RE-SINCRONIZA la boca a esa voz. No usa el voice changer (STS) propio.
 * Reusa la generación Veo de FalDynamicVideoProvider (image-to-video) y solo cambia el post.
 */
export class SyncDynamicProvider extends FalDynamicVideoProvider {
  private syncApiKey: string;
  private syncModel: string;
  private ttsSpeed: number;
  private ttsPronunciation: Record<string, string>;
  private ttsColonToComma: boolean;
  private readonly api = "https://api.sync.so";
  private readonly ttsModel = "eleven_multilingual_v2";

  constructor(opts: {
    falKey: string;
    elevenLabsApiKey: string;
    falModel: string;
    stsModel: string;
    syncApiKey: string;
    syncModel: string;
    ttsSpeed?: number;
    ttsPronunciation?: Record<string, string>;
    ttsColonToComma?: boolean;
  }) {
    super(opts);
    this.syncApiKey = opts.syncApiKey;
    this.syncModel = opts.syncModel;
    this.ttsSpeed = opts.ttsSpeed ?? 1;
    this.ttsPronunciation = opts.ttsPronunciation ?? {};
    this.ttsColonToComma = opts.ttsColonToComma ?? false;
  }

  /**
   * Normaliza el texto SOLO para el TTS (no el guion visible): aplica el diccionario de pronunciación
   * (palabra completa, insensible a may/min) y, si está activo, convierte ":" → "," (pausa más corta).
   */
  private respell(text: string): string {
    let out = text;
    for (const [from, to] of Object.entries(this.ttsPronunciation)) {
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`\\b${esc}\\b`, "gi"), to);
    }
    if (this.ttsColonToComma) out = out.replace(/:/g, ",");
    return out;
  }

  /**
   * TTS propio con ElevenLabs (cuando ttsSpeed != 1, ya que el TTS integrado de Sync no expone speed).
   * Devuelve el audio mp3 para subirlo a Sync como input de tipo "audio".
   */
  private async elevenTts(text: string, voiceId: string, vs: DynamicSceneInput["voiceSettings"]): Promise<Buffer> {
    if (!this.elevenLabsApiKey) throw new Error("Sync ttsSpeed: falta ELEVENLABS_API_KEY para el TTS con speed.");
    return withRetry(async () => {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "xi-api-key": this.elevenLabsApiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: this.ttsModel,
            voice_settings: {
              stability: vs?.stability ?? 0.5,
              similarity_boost: vs?.similarity_boost ?? 0.75,
              style: vs?.style ?? 0,
              use_speaker_boost: vs?.speaker_boost ?? true,
              speed: this.ttsSpeed,
            },
          }),
        },
      );
      if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    }, "elevenlabs tts (speed)");
  }

  /** Sube un archivo local a Sync (presigned URL) y devuelve la URL pública usable en el input. */
  private async upload(path: string, contentType: string): Promise<string> {
    const bytes = readFileSync(path);
    const { uploadUrl, url } = await withRetry(async () => {
      const res = await fetch(`${this.api}/v2/assets/upload`, {
        method: "POST",
        headers: { "x-api-key": this.syncApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: basename(path), size: bytes.length, contentType }),
      });
      if (!res.ok) throw new Error(`Sync assets/upload ${res.status}: ${await res.text()}`);
      return (await res.json()) as { uploadUrl: string; url: string };
    }, "sync upload-url");
    await withRetry(async () => {
      const res = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
      if (!res.ok) throw new Error(`Sync PUT ${res.status}: ${await res.text()}`);
    }, "sync put");
    return url;
  }

  override async generate(input: DynamicSceneInput): Promise<void> {
    if (!input.referenceImage) throw new Error("Sync: falta la imagen base (frame inicial para Veo).");
    if (!input.voiceId || !input.script) throw new Error("Sync requiere voiceId y script (diálogo) para el TTS.");

    const tmp = mkdtempSync(join(tmpdir(), "syncscene-"));
    const veoMp4 = join(tmp, "veo.mp4");

    // 1) Visual con Veo (image-to-video). Mantenemos su audio (cara hablando = mejor base de lip-sync).
    await this.generateVeo(input, veoMp4);
    try {
      copyFileSync(veoMp4, input.outputPath.replace(/\.mp4$/, ".veo-raw.mp4"));
    } catch {
      /* no crítico */
    }

    // 2) Subir el visual a Sync.
    log.info("Subiendo visual a Sync...");
    const videoUrl = await this.upload(veoMp4, "video/mp4");

    // 3) Audio: si ttsSpeed != 1, generamos el TTS con ElevenLabs (con speed) y lo pasamos como audio;
    //    si no, dejamos que Sync haga el TTS integrado (type "text").
    const vs = input.voiceSettings;
    const ttsScript = this.respell(input.script); // respelling de nombres propios solo para el TTS
    let audioInput: Record<string, unknown>;
    if (this.ttsSpeed !== 1) {
      log.info(`TTS propio (ElevenLabs, speed=${this.ttsSpeed})...`);
      const audioBuf = await this.elevenTts(ttsScript, input.voiceId, vs);
      const audioPath = join(tmp, "voice.mp3");
      writeFileSync(audioPath, audioBuf);
      const audioUrl = await this.upload(audioPath, "audio/mpeg");
      audioInput = { type: "audio", url: audioUrl };
    } else {
      audioInput = {
        type: "text",
        provider: {
          name: "elevenlabs",
          voiceId: input.voiceId,
          script: ttsScript,
          stability: vs?.stability ?? 0.5,
          similarityBoost: vs?.similarity_boost ?? 0.75,
        },
      };
    }

    log.info(`Sync lip-sync (${this.syncModel})...`);
    const job = await withRetry(async () => {
      const res = await fetch(`${this.api}/v2/generate`, {
        method: "POST",
        headers: { "x-api-key": this.syncApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.syncModel, input: [{ type: "video", url: videoUrl }, audioInput] }),
      });
      if (!res.ok) throw new Error(`Sync generate ${res.status}: ${await res.text()}`);
      return (await res.json()) as { id: string; status: string };
    }, "sync generate");

    // 4) Poll hasta COMPLETED.
    let status = job.status;
    let data: { status: string; outputUrl?: string; error?: string; errorCode?: string } = job;
    let tries = 0;
    while (!["COMPLETED", "FAILED", "REJECTED"].includes(status)) {
      await new Promise((r) => setTimeout(r, 6000));
      data = await withRetry(async () => {
        const res = await fetch(`${this.api}/v2/generate/${job.id}`, { headers: { "x-api-key": this.syncApiKey } });
        if (!res.ok) throw new Error(`Sync status ${res.status}: ${await res.text()}`);
        return (await res.json()) as { status: string; outputUrl?: string; error?: string; errorCode?: string };
      }, "sync status");
      status = data.status;
      if (++tries > 100) throw new Error("Sync: timeout esperando el lip-sync");
    }
    if (status !== "COMPLETED" || !data.outputUrl) {
      throw new Error(`Sync terminó en ${status}: ${data.error ?? data.errorCode ?? "sin outputUrl"}`);
    }

    // 5) Descargar el resultado.
    const buf = await withRetry(async () => {
      const res = await fetch(data.outputUrl!);
      if (!res.ok) throw new Error(`Sync descarga ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }, "sync download");
    writeFileSync(input.outputPath, buf);
    log.info(`Escena dinámica (Sync) lista -> ${input.outputPath}`);
  }
}
