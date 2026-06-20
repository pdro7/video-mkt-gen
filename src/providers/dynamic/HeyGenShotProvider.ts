import { writeFileSync } from "node:fs";
import { createLogger } from "../../util/logger.js";
import { withRetry } from "../../util/retry.js";
import type { DynamicProvider, DynamicSceneInput } from "./BaseDynamicVideoProvider.js";

const log = createLogger("heygen-shot");
const API_BASE = "https://api.heygen.com";

/**
 * Motor de escenas dinámicas con HeyGen Cinematic Avatar (Avatar Shots, Seedance 2.0 por debajo).
 * POST /v3/videos con type:"cinematic_avatar" + avatar_id (LOOK registrado). La VOZ es la nativa
 * configurada en el look (sin ElevenLabs STS). Devuelve un mp4 final con voz + lip-sync → se descarga.
 * Usa créditos de API de HeyGen (beta). No extiende BaseDynamicVideoProvider (no hay cadena STS).
 */
export class HeyGenShotProvider implements DynamicProvider {
  private apiKey: string;
  private resolution: "720p" | "1080p";

  constructor(opts: { apiKey: string; resolution: "720p" | "1080p" }) {
    this.apiKey = opts.apiKey;
    this.resolution = opts.resolution;
  }

  async generate(input: DynamicSceneInput): Promise<void> {
    if (!input.heygenLookId) {
      throw new Error("HeyGen Shots: el personaje no tiene 'heygenLookId' (requerido para provider='heygen-shot').");
    }
    const headers = { "X-Api-Key": this.apiKey, "Content-Type": "application/json" };
    const body = {
      type: "cinematic_avatar",
      prompt: input.prompt,
      avatar_id: [input.heygenLookId],
      aspect_ratio: input.aspectRatio,
      resolution: this.resolution,
      auto_duration: true,
    };

    log.info(`HeyGen Cinematic Avatar (${this.resolution})...`);
    const created = await withRetry(async () => {
      const res = await fetch(`${API_BASE}/v3/videos`, { method: "POST", headers, body: JSON.stringify(body) });
      const t = await res.text();
      if (!res.ok) throw new Error(`HeyGen Shots create ${res.status}: ${t}`);
      return JSON.parse(t) as { data?: { video_id?: string }; video_id?: string };
    }, "heygen-shot create");
    const videoId = created.data?.video_id ?? created.video_id;
    if (!videoId) throw new Error(`HeyGen Shots no devolvió video_id: ${JSON.stringify(created)}`);

    // Poll del estado.
    let status = "processing";
    let tries = 0;
    let videoUrl: string | undefined;
    while (status !== "completed") {
      await new Promise((r) => setTimeout(r, 10000));
      const data = await withRetry(async () => {
        const res = await fetch(`${API_BASE}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
          headers: { "X-Api-Key": this.apiKey },
        });
        if (!res.ok) throw new Error(`HeyGen Shots status ${res.status}: ${await res.text()}`);
        const j = (await res.json()) as { data?: { status?: string; video_url?: string; error?: unknown } };
        return j.data ?? {};
      }, "heygen-shot status");
      status = data.status ?? "processing";
      if (status === "failed") throw new Error(`HeyGen Shots falló: ${JSON.stringify(data.error ?? data)}`);
      if (status === "completed") videoUrl = data.video_url;
      if (++tries > 90) throw new Error("HeyGen Shots: timeout esperando el render");
    }
    if (!videoUrl) throw new Error("HeyGen Shots: completado sin video_url.");

    // Descargar el mp4 final (ya trae voz + lip-sync).
    const buf = await withRetry(async () => {
      const res = await fetch(videoUrl!);
      if (!res.ok) throw new Error(`HeyGen Shots descarga ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }, "heygen-shot download");
    writeFileSync(input.outputPath, buf);
    log.info(`Escena dinámica (HeyGen Shots) lista -> ${input.outputPath}`);
  }
}
