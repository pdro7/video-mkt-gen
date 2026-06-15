/**
 * Voz de una escena. Dos caminos:
 *  - "text": HeyGen sintetiza con su voice_id (que puede ser una voz ElevenLabs
 *    conectada dentro de HeyGen). No requiere clave de ElevenLabs.
 *  - "audio": audio ya generado fuera (ElevenLabs propio) que HeyGen sólo sincroniza.
 */
export type SceneVoice =
  | { kind: "text"; text: string; voiceId: string }
  | { kind: "audio"; data: Buffer; mimeType: string };

/**
 * Proveedor de video por escena: anima la imagen del avatar (talking photo) diciendo
 * la línea, con la voz indicada y un motion prompt (Avatar IV).
 */
export interface CreateSceneVideoInput {
  /** Imagen base del personaje (talking photo) que se animará. */
  image: Buffer;
  imageMimeType: string;
  /** Voz de la escena (texto+voice_id o audio). */
  voice: SceneVoice;
  /** Avatar IV: instrucción de movimiento/gesto y energía. */
  motionPrompt?: string;
  expressiveness?: "high" | "medium" | "low";
  aspectRatio?: string;
  resolution?: "720p" | "1080p" | "4k";
  useAvatarIV?: boolean;
}

export interface SceneVideoResult {
  providerJobId: string;
  videoUrl?: string;
  status: "processing" | "completed" | "failed";
  error?: string;
}

export interface VideoProvider {
  /** Crea el job de video y devuelve su id (no espera a que termine). */
  createSceneVideo(input: CreateSceneVideoInput): Promise<SceneVideoResult>;
  /** Consulta el estado de un job creado previamente. */
  getStatus(providerJobId: string): Promise<SceneVideoResult>;
}
