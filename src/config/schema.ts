import { z } from "zod";

/**
 * Configuración del proyecto (config.json). Es el "seam" de producto: el cliente
 * cambia este archivo + .env por sus credenciales/personajes.
 *
 * Contiene el roster ESTABLE de personajes (imagen base de referencia + voz ElevenLabs).
 * El brief creativo y el spec generado por Claude viven aparte.
 */

export const elevenLabsVoiceParamsSchema = z.object({
  stability: z.number().min(0).max(1).default(0.5),
  similarity_boost: z.number().min(0).max(1).default(0.8),
  style: z.number().min(0).max(1).default(0.2),
  speaker_boost: z.boolean().default(true),
  model: z.string().default("eleven_multilingual_v2"),
});

export const characterConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gender: z.string().optional(),
  ageRange: z.string().optional(),
  wardrobe: z.string().optional(),
  /** Imagen base de referencia (fondo neutro) — p. ej. Avatars/elena.png. */
  referenceImagePath: z.string().min(1),
  /**
   * Id de voz en HeyGen (camino por defecto). Puede ser una voz de ElevenLabs
   * CONECTADA dentro de HeyGen: HeyGen llama a ElevenLabs internamente; aquí solo va el id.
   * Requerido cuando providers.voice === "heygen".
   */
  heygenVoiceId: z.string().optional(),
  /**
   * Solo para el camino alternativo providers.voice === "elevenlabs" (TTS propio,
   * requiere ELEVENLABS_API_KEY). Genera el audio fuera de HeyGen y se lo pasa como asset.
   */
  elevenLabs: z
    .object({ voiceId: z.string().min(1), params: elevenLabsVoiceParamsSchema.default({}) })
    .optional(),
});

export const appConfigSchema = z.object({
  /** Nombre de la empresa/cliente dueño de la cuenta (aparece como video.client en el spec). */
  client: z.string().min(1),
  /** Ruta a la librería de zonas (decorados reutilizables, id -> descripción). */
  zonesPath: z.string().default("zones.json"),
  providers: z.object({
    llm: z.enum(["claude"]).default("claude"),
    /** "heygen" = voz manejada por HeyGen vía voice_id (puede ser ElevenLabs conectada en HeyGen).
     *  "elevenlabs" = TTS propio fuera de HeyGen (requiere ELEVENLABS_API_KEY). */
    voice: z.enum(["heygen", "elevenlabs"]).default("heygen"),
    video: z.enum(["heygen"]).default("heygen"),
    /** Generación de base_images por API. "none" = usar la imagen del personaje tal cual. */
    image: z.enum(["none", "nano-banana", "fal", "openai", "kie"]).default("none"),
  }),
  llm: z
    .object({ model: z.string().default("claude-opus-4-8"), maxTokens: z.number().int().positive().default(8000) })
    .default({}),
  /** Modelo de imágenes (cuando providers.image !== "none").
   *  Nano Banana 2 (Gemini 3 Pro Image) = "gemini-3-pro-image-preview".
   *  Nano Banana (Gemini 2.5 Flash Image) = "gemini-2.5-flash-image". */
  image: z
    .object({
      model: z.string().default("gemini-3-pro-image-preview"),
      resolution: z.enum(["1K", "2K", "4K"]).optional(),
    })
    .default({}),
  video: z
    .object({
      aspectRatio: z.string().default("16:9"),
      resolution: z.enum(["720p", "1080p", "4k"]).default("1080p"),
      useAvatarIV: z.boolean().default(true),
      /** Energía/rango de movimiento de Avatar IV. "low" sale rígido; por defecto "high". */
      defaultExpressiveness: z.enum(["high", "medium", "low"]).default("high"),
      /** Motor para escenas dinámicas (avatar en movimiento): Veo + voice changer. */
      dynamic: z
        .object({
          veoModel: z.string().default("veo-3.1-generate-preview"),
          stsModel: z.string().default("eleven_multilingual_sts_v2"),
        })
        .default({}),
    })
    .default({}),
  constraints: z
    .object({
      minScenes: z.number().int().positive().default(10),
      maxScenes: z.number().int().positive().default(14),
      wordsPerSecond: z.number().positive().default(2.5),
    })
    .default({}),
  characters: z.array(characterConfigSchema).min(1),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type CharacterConfig = z.infer<typeof characterConfigSchema>;
export type ElevenLabsVoiceParams = z.infer<typeof elevenLabsVoiceParamsSchema>;
