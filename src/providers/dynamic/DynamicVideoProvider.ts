import { writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../../util/logger.js";
import { withRetry } from "../../util/retry.js";
import { BaseDynamicVideoProvider, type DynamicSceneInput } from "./BaseDynamicVideoProvider.js";

const log = createLogger("dynamic");

export type { DynamicSceneInput };

/**
 * Motor de escenas dinámicas con Veo de Google (Gemini API), reference-to-video.
 * La cadena de voz (STS) y el mux viven en BaseDynamicVideoProvider.
 * Usa GOOGLE_API_KEY (Veo) y ELEVENLABS_API_KEY (STS, permiso speech_to_speech).
 */
export class DynamicVideoProvider extends BaseDynamicVideoProvider {
  private ai: GoogleGenAI;
  private googleApiKey: string;
  private veoModel: string;

  constructor(opts: { googleApiKey: string; elevenLabsApiKey: string; veoModel: string; stsModel: string }) {
    super({ elevenLabsApiKey: opts.elevenLabsApiKey, stsModel: opts.stsModel });
    this.ai = new GoogleGenAI({ apiKey: opts.googleApiKey });
    this.googleApiKey = opts.googleApiKey;
    this.veoModel = opts.veoModel;
  }

  /** Veo reference-to-video: referencia de personaje + prompt -> mp4 (async: lanzar+poll+descargar). */
  protected async generateVeo(input: DynamicSceneInput, outMp4: string): Promise<void> {
    if (!input.referenceImage) throw new Error("Veo: falta referenceImage.");
    const refBytes = input.referenceImage.toString("base64");
    const refMime = input.referenceMimeType ?? "image/jpeg";
    log.info(`Veo (${this.veoModel}) reference-to-video...`);
    let operation = await withRetry(
      () =>
        this.ai.models.generateVideos({
          model: this.veoModel,
          prompt: input.prompt,
          config: {
            aspectRatio: input.aspectRatio,
            numberOfVideos: 1,
            referenceImages: [
              { image: { imageBytes: refBytes, mimeType: refMime }, referenceType: "asset" },
            ],
          } as Record<string, unknown>,
        }),
      "veo generateVideos",
    );

    let tries = 0;
    while (!operation.done) {
      await new Promise((r) => setTimeout(r, 10000));
      operation = await withRetry(() => this.ai.operations.getVideosOperation({ operation }), "veo poll");
      if (++tries > 90) throw new Error("Veo: timeout esperando el render");
    }
    if (operation.error) throw new Error(`Veo error: ${JSON.stringify(operation.error)}`);

    const video = operation.response?.generatedVideos?.[0]?.video as { uri?: string; videoBytes?: string } | undefined;
    if (video?.videoBytes) {
      writeFileSync(outMp4, Buffer.from(video.videoBytes, "base64"));
    } else if (video?.uri) {
      const url = video.uri.includes("key=") ? video.uri : `${video.uri}${video.uri.includes("?") ? "&" : "?"}key=${this.googleApiKey}`;
      const buf = await withRetry(async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Veo descarga ${res.status}: ${await res.text()}`);
        return Buffer.from(await res.arrayBuffer());
      }, "veo download");
      writeFileSync(outMp4, buf);
    } else {
      throw new Error("Veo no devolvió video (ni uri ni bytes).");
    }
  }
}
