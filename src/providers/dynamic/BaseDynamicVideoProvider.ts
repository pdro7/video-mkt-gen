import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../util/logger.js";
import { withRetry } from "../../util/retry.js";

const log = createLogger("dynamic");
const run = promisify(execFile);

export interface DynamicSceneInput {
  /** Foto de referencia del personaje (su retrato), para la identidad. Camino Veo (gemini/fal). */
  referenceImage?: Buffer;
  referenceMimeType?: string;
  /** Prompt del modelo de video (entorno + movimiento + apariencia + la línea de diálogo). */
  prompt: string;
  /** voice_id de ElevenLabs para revoz (la voz real del personaje). Camino Veo (gemini/fal). */
  voiceId?: string;
  /** Ajustes de voz para el STS (empujan la conversión hacia la voz objetivo). */
  voiceSettings?: { stability: number; similarity_boost: number; style: number; speaker_boost: boolean };
  /** Id del LOOK de HeyGen. Camino "heygen-shot" (Cinematic Avatar; voz nativa del look). */
  heygenLookId?: string;
  aspectRatio: string;
  /** Ruta donde se escribe el mp4 final. */
  outputPath: string;
}

/** Interfaz del motor de escenas dinámicas: genera el mp4 final con avatar en movimiento + voz real. */
export interface DynamicProvider {
  generate(input: DynamicSceneInput): Promise<void>;
}

/**
 * Base común de los motores de escenas dinámicas. La receta validada es:
 *   1. reference-to-video: foto del personaje + prompt -> video con movimiento + voz genérica.
 *   2. ElevenLabs Voice Changer (speech-to-speech): revoz a la voz real, preservando timing.
 *   3. ffmpeg: swap del audio + auto-trim de la cola muda.
 * El paso (1) lo implementa cada subclase en `generateVeo` (Gemini, fal, etc.); (2) y (3) son comunes.
 */
export abstract class BaseDynamicVideoProvider implements DynamicProvider {
  protected elevenLabsApiKey: string;
  protected stsModel: string;

  constructor(opts: { elevenLabsApiKey: string; stsModel: string }) {
    this.elevenLabsApiKey = opts.elevenLabsApiKey;
    this.stsModel = opts.stsModel;
  }

  /** Genera el clip de video (con voz genérica) en `outMp4`. Lo implementa cada proveedor concreto. */
  protected abstract generateVeo(input: DynamicSceneInput, outMp4: string): Promise<void>;

  /** Genera la escena dinámica completa y escribe el mp4 final en outputPath. */
  async generate(input: DynamicSceneInput): Promise<void> {
    if (!input.referenceImage || !input.voiceId) {
      throw new Error("El motor Veo (gemini/fal) requiere referenceImage y voiceId (camino con voice changer).");
    }
    const tmp = mkdtempSync(join(tmpdir(), "dynscene-"));
    const veoMp4 = join(tmp, "veo.mp4");
    const genAudio = join(tmp, "gen.mp3");
    const voiceAudio = join(tmp, "voice.mp3");

    await this.generateVeo(input, veoMp4);
    // Guarda el clip crudo (voz genérica) junto al final, para poder re-vocear sin re-render.
    try {
      copyFileSync(veoMp4, input.outputPath.replace(/\.mp4$/, ".veo-raw.mp4"));
    } catch {
      /* no crítico */
    }
    // Extraer audio genérico del clip.
    await run("ffmpeg", ["-y", "-v", "error", "-i", veoMp4, "-vn", "-c:a", "libmp3lame", "-q:a", "2", genAudio]);
    // Revoz a la voz real (preserva timing -> el lip-sync sigue cuadrando).
    await this.voiceChange(genAudio, input.voiceId, voiceAudio, input.voiceSettings);

    // Auto-trim: los clips suelen venir de 8s fijos; recortamos la cola muda tras el fin del habla.
    const total = await this.duration(veoMp4);
    const speechEnd = await this.detectSpeechEnd(voiceAudio, total);
    const muxArgs = ["-y", "-v", "error", "-i", veoMp4, "-i", voiceAudio, "-map", "0:v:0", "-map", "1:a:0"];
    if (speechEnd != null) {
      const cut = Math.min(total, speechEnd + 0.4).toFixed(2); // +0.4s de cola
      muxArgs.push("-t", cut, "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac");
      log.info(`Trim: voz termina ~${speechEnd.toFixed(1)}s; recorto a ${cut}s (de ${total.toFixed(1)}s).`);
    } else {
      muxArgs.push("-c:v", "copy", "-c:a", "aac", "-shortest");
    }
    muxArgs.push(input.outputPath);
    await run("ffmpeg", muxArgs);
    log.info(`Escena dinámica lista -> ${input.outputPath}`);
  }

  /** Duración (s) de un archivo de media. */
  protected async duration(path: string): Promise<number> {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]);
    return parseFloat(stdout.trim()) || 0;
  }

  /**
   * Detecta el fin del habla = inicio de la zona de silencio FINAL (la cola muerta del clip).
   * Los modelos meten ambiente continuo, así que usamos -30dB y solo consideramos la zona de
   * silencio que llega hasta el final del clip. Devuelve null si no hay cola significativa (>0.6s).
   */
  protected async detectSpeechEnd(audioPath: string, total: number): Promise<number | null> {
    let stderr = "";
    try {
      const r = await run("ffmpeg", ["-i", audioPath, "-af", "silencedetect=noise=-30dB:d=0.4", "-f", "null", "-"]);
      stderr = r.stderr;
    } catch (e) {
      stderr = (e as { stderr?: string }).stderr ?? "";
    }
    const starts: number[] = [];
    const ends: number[] = [];
    for (const m of stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
      (m[1] === "start" ? starts : ends).push(parseFloat(m[2]!));
    }
    if (!starts.length) return null;
    const lastStart = starts[starts.length - 1]!;
    const lastEnd = ends.length ? ends[ends.length - 1]! : total;
    const reachesEnd = lastEnd >= total - 0.5;
    return reachesEnd && total - lastStart > 0.6 ? lastStart : null;
  }

  /** ElevenLabs speech-to-speech: revoz el audio a la voz objetivo (mismo timing). */
  protected async voiceChange(
    audioPath: string,
    voiceId: string,
    outPath: string,
    settings?: { stability: number; similarity_boost: number; style: number; speaker_boost: boolean },
  ): Promise<void> {
    log.info("Voice Changer (ElevenLabs STS)...");
    // Se respetan los ajustes configurados por personaje. Quitar el ruido de fondo del clip ayuda
    // a que adopte la voz real de forma más consistente.
    const vs = {
      stability: settings?.stability ?? 0.33,
      similarity_boost: settings?.similarity_boost ?? 0.75,
      style: settings?.style ?? 0,
      use_speaker_boost: settings?.speaker_boost ?? true,
    };
    const fd = new FormData();
    fd.append("model_id", this.stsModel);
    fd.append("voice_settings", JSON.stringify(vs));
    fd.append("remove_background_noise", "true");
    fd.append("audio", new Blob([readFileSync(audioPath)], { type: "audio/mpeg" }), "audio.mp3");
    const buf = await withRetry(async () => {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        { method: "POST", headers: { "xi-api-key": this.elevenLabsApiKey }, body: fd },
      );
      if (!res.ok) throw new Error(`ElevenLabs STS ${res.status}: ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    }, "elevenlabs STS");
    writeFileSync(outPath, buf);
  }
}
