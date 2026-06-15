import { createLogger } from "../../util/logger.js";
import type {
  CreateSceneVideoInput,
  SceneVideoResult,
  VideoProvider,
} from "./VideoProvider.js";

const log = createLogger("heygen");

const UPLOAD_BASE = "https://upload.heygen.com";
const API_BASE = "https://api.heygen.com";

interface UploadedAsset {
  id: string;
  url: string;
  image_key?: string;
}

/**
 * Proveedor de video con HeyGen, endpoint v3 (`POST /v3/videos`) con Avatar IV.
 *
 * Por qué v3: `motion_prompt` y `expressiveness` (gestos/cuerpo) son nativos del v3; en v2
 * se ignoraban y el avatar salía rígido. Para una imagen propia (generada por Nano Banana)
 * se usa `type: "image"` + `image_url` del asset subido (no requiere registrar un avatar).
 *
 * Flujo por escena:
 *   1. sube la imagen como asset            -> image_url
 *   2. (voz por audio) sube el audio asset  -> audio_url   | (voz por texto) script + voice_id
 *   3. POST /v3/videos con engine avatar_iv, motion_prompt, expressiveness, aspect_ratio, resolution
 *   4. estado vía /v1/video_status.get (polling en el pipeline)
 */
export class HeyGenProvider implements VideoProvider {
  private apiKey: string;

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }

  async createSceneVideo(input: CreateSceneVideoInput): Promise<SceneVideoResult> {
    const imageAsset = await this.uploadAsset(input.image, input.imageMimeType, "imagen de escena");

    // Voz: texto+voice_id (HeyGen sintetiza, p. ej. ElevenLabs conectada) o audio propio.
    let voiceFields: Record<string, unknown>;
    if (input.voice.kind === "text") {
      voiceFields = { script: input.voice.text, voice_id: input.voice.voiceId };
    } else {
      const audioAsset = await this.uploadAsset(input.voice.data, input.voice.mimeType, "audio");
      voiceFields = { audio_url: audioAsset.url };
    }

    const body: Record<string, unknown> = {
      title: "video-gen scene",
      type: "image",
      image: { type: "url", url: imageAsset.url },
      aspect_ratio: input.aspectRatio ?? "16:9",
      resolution: input.resolution ?? "1080p",
      ...(input.motionPrompt ? { motion_prompt: input.motionPrompt } : {}),
      ...(input.expressiveness ? { expressiveness: input.expressiveness } : {}),
      ...voiceFields,
    };

    log.info(`Creando video de escena en HeyGen v3 (Avatar IV, expressiveness=${input.expressiveness ?? "default"})...`);
    const res = await this.fetchJson(`${API_BASE}/v3/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const videoId = res?.data?.video_id ?? res?.video_id ?? res?.data?.id;
    if (!videoId) throw new Error(`HeyGen v3 no devolvió video_id: ${JSON.stringify(res)}`);
    return { providerJobId: videoId, status: "processing" };
  }

  async getStatus(providerJobId: string): Promise<SceneVideoResult> {
    const res = await this.fetchJson(
      `${API_BASE}/v1/video_status.get?video_id=${encodeURIComponent(providerJobId)}`,
      { method: "GET" },
    );
    const data = res?.data ?? {};
    const status: string = data.status ?? "processing";
    if (status === "completed") return { providerJobId, status: "completed", videoUrl: data.video_url };
    if (status === "failed") {
      return { providerJobId, status: "failed", error: data.error?.message ?? data.error ?? "render fallido" };
    }
    return { providerJobId, status: "processing" };
  }

  /** Sube bytes como asset (imagen o audio) y devuelve su id, url e image_key. */
  private async uploadAsset(data: Buffer, contentType: string, what: string): Promise<UploadedAsset> {
    log.info(`Subiendo ${what} como asset...`);
    const res = await fetch(`${UPLOAD_BASE}/v1/asset`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": contentType },
      body: new Uint8Array(data),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HeyGen upload (${what}) -> ${res.status}: ${text}`);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HeyGen upload (${what}) devolvió no-JSON: ${text}`);
    }
    const url = json?.data?.url;
    const id = json?.data?.id;
    if (!url || !id) throw new Error(`HeyGen upload (${what}) sin url/id: ${text}`);
    return { id, url, image_key: json?.data?.image_key };
  }

  private async fetchJson(url: string, init: RequestInit): Promise<any> {
    const res = await fetch(url, {
      ...init,
      headers: { "X-Api-Key": this.apiKey, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HeyGen ${init.method} ${url} -> ${res.status}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`HeyGen devolvió una respuesta no-JSON: ${text}`);
    }
  }
}
