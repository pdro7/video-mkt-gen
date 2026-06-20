import { writeFileSync } from "node:fs";
import { createLogger } from "../../util/logger.js";
import { withRetry } from "../../util/retry.js";
import { BaseDynamicVideoProvider, type DynamicSceneInput } from "./BaseDynamicVideoProvider.js";

const log = createLogger("dynamic-fal");

/**
 * Motor de escenas dinámicas con Veo 3.1 reference-to-video vía fal.ai.
 * Misma calidad (mismo modelo Veo), pero con cuota/facturación de fal (independiente del
 * límite diario del proyecto de Gemini). La cadena de voz (STS) y el mux viven en la base.
 *
 * fal usa la API de cola: submit -> poll status -> get result. La imagen de referencia se
 * pasa como data URI en `image_urls` (fal acepta data URIs, así evitamos subirla aparte).
 * Auth: header `Authorization: Key <FAL_KEY>`.
 */
export class FalDynamicVideoProvider extends BaseDynamicVideoProvider {
  private falKey: string;
  private model: string;

  constructor(opts: { falKey: string; elevenLabsApiKey: string; falModel: string; stsModel: string }) {
    super({ elevenLabsApiKey: opts.elevenLabsApiKey, stsModel: opts.stsModel });
    this.falKey = opts.falKey;
    this.model = opts.falModel;
  }

  protected async generateVeo(input: DynamicSceneInput, outMp4: string): Promise<void> {
    log.info(`Veo 3.1 reference-to-video vía fal (${this.model})...`);
    if (!input.referenceImage) throw new Error("fal Veo: falta referenceImage.");
    const auth = { Authorization: `Key ${this.falKey}` };
    const dataUri = `data:${input.referenceMimeType ?? "image/jpeg"};base64,${input.referenceImage.toString("base64")}`;

    // image-to-video (frame inicial = la imagen base de la escena): Veo pronuncia bien las siglas
    // (a diferencia de reference-to-video). El "asset" reference-to-video usa el retrato del personaje.
    const isI2V = this.model.includes("image-to-video");
    const payload = isI2V
      ? { prompt: input.prompt, image_url: dataUri, aspect_ratio: input.aspectRatio, resolution: "720p", generate_audio: true }
      : { prompt: input.prompt, image_urls: [dataUri], aspect_ratio: input.aspectRatio };

    // 1) Submit a la cola.
    const submit = await withRetry(async () => {
      const res = await fetch(`https://queue.fal.run/${this.model}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`fal submit ${res.status}: ${await res.text()}`);
      return (await res.json()) as { request_id: string; status_url: string; response_url: string };
    }, "fal submit");

    // 2) Poll del estado.
    let tries = 0;
    let status = "IN_QUEUE";
    while (status !== "COMPLETED") {
      await new Promise((r) => setTimeout(r, 10000));
      const s = await withRetry(async () => {
        const res = await fetch(submit.status_url, { headers: auth });
        if (!res.ok) throw new Error(`fal status ${res.status}: ${await res.text()}`);
        return (await res.json()) as { status: string };
      }, "fal status");
      status = s.status;
      if (status === "FAILED" || status === "ERROR") throw new Error(`fal Veo falló: ${JSON.stringify(s)}`);
      if (++tries > 90) throw new Error("fal Veo: timeout esperando el render");
    }

    // 3) Resultado + descarga del mp4.
    const result = await withRetry(async () => {
      const res = await fetch(submit.response_url, { headers: auth });
      if (!res.ok) throw new Error(`fal result ${res.status}: ${await res.text()}`);
      return (await res.json()) as { video?: { url?: string } };
    }, "fal result");
    const url = result.video?.url;
    if (!url) throw new Error(`fal no devolvió video.url: ${JSON.stringify(result)}`);
    const buf = await withRetry(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fal descarga ${res.status}: ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    }, "fal download");
    writeFileSync(outMp4, buf);
  }
}
