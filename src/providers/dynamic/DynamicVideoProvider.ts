import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../../util/logger.js";

const log = createLogger("dynamic");
const run = promisify(execFile);

/**
 * Proveedor de escenas DINÁMICAS (avatar en movimiento). Receta validada:
 *   1. Veo 3.1 reference-to-video: foto del personaje como referencia + prompt -> video con
 *      movimiento + diálogo (voz genérica) y lip-sync.
 *   2. ElevenLabs Voice Changer (speech-to-speech): revoz a la voz real, preservando timing.
 *   3. ffmpeg: swap del audio en el video.
 * Usa GOOGLE_API_KEY (Veo) y ELEVENLABS_API_KEY (STS, permiso speech_to_speech).
 */
export interface DynamicSceneInput {
  /** Foto de referencia del personaje (su retrato), para la identidad. */
  referenceImage: Buffer;
  referenceMimeType: string;
  /** Prompt de Veo (entorno + movimiento + apariencia + la línea de diálogo). */
  prompt: string;
  /** voice_id de ElevenLabs para revoz (la voz real del personaje). */
  voiceId: string;
  aspectRatio: string;
  /** Ruta donde se escribe el mp4 final. */
  outputPath: string;
}

export class DynamicVideoProvider {
  private ai: GoogleGenAI;
  private googleApiKey: string;
  private elevenLabsApiKey: string;
  private veoModel: string;
  private stsModel: string;

  constructor(opts: { googleApiKey: string; elevenLabsApiKey: string; veoModel: string; stsModel: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts.googleApiKey });
    this.googleApiKey = opts.googleApiKey;
    this.elevenLabsApiKey = opts.elevenLabsApiKey;
    this.veoModel = opts.veoModel;
    this.stsModel = opts.stsModel;
  }

  /** Genera la escena dinámica completa y escribe el mp4 final en outputPath. */
  async generate(input: DynamicSceneInput): Promise<void> {
    const tmp = mkdtempSync(join(tmpdir(), "dynscene-"));
    const veoMp4 = join(tmp, "veo.mp4");
    const genAudio = join(tmp, "gen.mp3");
    const voiceAudio = join(tmp, "voice.mp3");

    await this.generateVeo(input, veoMp4);
    // Extraer audio genérico del clip de Veo.
    await run("ffmpeg", ["-y", "-v", "error", "-i", veoMp4, "-vn", "-c:a", "libmp3lame", "-q:a", "2", genAudio]);
    // Revoz a la voz real (preserva timing -> el lip-sync sigue cuadrando).
    await this.voiceChange(genAudio, input.voiceId, voiceAudio);
    // Swap del audio.
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", veoMp4, "-i", voiceAudio,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", input.outputPath,
    ]);
    log.info(`Escena dinámica lista -> ${input.outputPath}`);
  }

  /** Veo reference-to-video: referencia de personaje + prompt -> mp4 (async: lanzar+poll+descargar). */
  private async generateVeo(input: DynamicSceneInput, outMp4: string): Promise<void> {
    log.info(`Veo (${this.veoModel}) reference-to-video...`);
    let operation = await this.ai.models.generateVideos({
      model: this.veoModel,
      prompt: input.prompt,
      config: {
        aspectRatio: input.aspectRatio,
        numberOfVideos: 1,
        referenceImages: [
          { image: { imageBytes: input.referenceImage.toString("base64"), mimeType: input.referenceMimeType }, referenceType: "asset" },
        ],
      } as Record<string, unknown>,
    });

    let tries = 0;
    while (!operation.done) {
      await new Promise((r) => setTimeout(r, 10000));
      operation = await this.ai.operations.getVideosOperation({ operation });
      if (++tries > 90) throw new Error("Veo: timeout esperando el render");
    }
    if (operation.error) throw new Error(`Veo error: ${JSON.stringify(operation.error)}`);

    const video = operation.response?.generatedVideos?.[0]?.video as { uri?: string; videoBytes?: string } | undefined;
    if (video?.videoBytes) {
      writeFileSync(outMp4, Buffer.from(video.videoBytes, "base64"));
    } else if (video?.uri) {
      const url = video.uri.includes("key=") ? video.uri : `${video.uri}${video.uri.includes("?") ? "&" : "?"}key=${this.googleApiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Veo descarga ${res.status}: ${await res.text()}`);
      writeFileSync(outMp4, Buffer.from(await res.arrayBuffer()));
    } else {
      throw new Error("Veo no devolvió video (ni uri ni bytes).");
    }
  }

  /** ElevenLabs speech-to-speech: revoz el audio a la voz objetivo (mismo timing). */
  private async voiceChange(audioPath: string, voiceId: string, outPath: string): Promise<void> {
    log.info("Voice Changer (ElevenLabs STS)...");
    const fd = new FormData();
    fd.append("model_id", this.stsModel);
    fd.append("audio", new Blob([readFileSync(audioPath)], { type: "audio/mpeg" }), "audio.mp3");
    const res = await fetch(
      `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      { method: "POST", headers: { "xi-api-key": this.elevenLabsApiKey }, body: fd },
    );
    if (!res.ok) throw new Error(`ElevenLabs STS ${res.status}: ${await res.text()}`);
    writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  }
}
