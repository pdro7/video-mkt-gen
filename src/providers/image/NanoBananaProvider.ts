import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../../util/logger.js";
import { withRetry } from "../../util/retry.js";
import { withTimeout } from "../../util/timeout.js";

/** Tope por intento de generación de imagen; si el modelo se cuelga, vence y se reintenta. */
const IMAGE_TIMEOUT_MS = 90_000;
import type {
  GenerateSceneInput,
  GeneratedImage,
  ImageProvider,
} from "./ImageProvider.js";

const log = createLogger("nano-banana");

/**
 * Proveedor de imágenes Gemini ("Nano Banana") vía Google AI Studio. Pasa la imagen base
 * del avatar como referencia (inlineData) para mantener la consistencia del personaje.
 * Modelo configurable: "gemini-3-pro-image-preview" (Nano Banana 2 / Pro) o
 * "gemini-2.5-flash-image" (Nano Banana / Flash).
 */
export class NanoBananaProvider implements ImageProvider {
  private client: GoogleGenAI;
  private model: string;
  private resolution?: "1K" | "2K" | "4K";

  constructor(opts: { apiKey: string; model?: string; resolution?: "1K" | "2K" | "4K" }) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? "gemini-2.5-flash-image";
    this.resolution = opts.resolution;
  }

  async generateScene(input: GenerateSceneInput): Promise<GeneratedImage> {
    // El prompt (texto) lo arma quien llama; aquí solo se adjunta(n) la(s) imagen(es) de
    // referencia del avatar como inlineData para conservar su apariencia/identidad.
    const parts: Array<Record<string, unknown>> = [{ text: input.prompt }];
    for (const ref of input.referenceImages) {
      parts.push({
        inlineData: { mimeType: ref.mimeType, data: ref.data.toString("base64") },
      });
    }

    // Control de aspect ratio / resolución (soportado por Gemini 3 Pro Image / Nano Banana 2).
    // El SDK acepta config.imageConfig; se mantiene además el aspect ratio en el prompt como respaldo.
    const imageConfig: Record<string, unknown> = {};
    if (input.aspectRatio) imageConfig.aspectRatio = input.aspectRatio;
    if (this.resolution) imageConfig.imageSize = this.resolution;

    log.info(`Generando imagen (${input.referenceImages.length} ref) con ${this.model}...`);
    const response = await withRetry(
      () =>
        withTimeout(
          this.client.models.generateContent({
            model: this.model,
            contents: [{ role: "user", parts }],
            ...(Object.keys(imageConfig).length ? { config: { imageConfig } as Record<string, unknown> } : {}),
          }),
          IMAGE_TIMEOUT_MS,
          `nano-banana ${this.model}`,
        ),
      `nano-banana ${this.model}`,
      6, // el modelo de imagen sufre picos de 503; más reintentos para aguantarlos
    );

    const candidate = response.candidates?.[0];
    const outParts = candidate?.content?.parts ?? [];
    for (const part of outParts) {
      const inline = part.inlineData;
      if (inline?.data) {
        return {
          data: Buffer.from(inline.data, "base64"),
          mimeType: inline.mimeType ?? "image/png",
        };
      }
    }

    const textBack = outParts
      .map((p) => p.text)
      .filter(Boolean)
      .join(" ");
    throw new Error(
      `El modelo no devolvió una imagen.${textBack ? ` Respuesta: ${textBack}` : ""}`,
    );
  }
}
