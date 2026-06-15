import type { AppConfig } from "../config/schema.js";
import type { Credentials } from "../config/config.js";
import type { LLMProvider } from "./llm/LLMProvider.js";
import type { VoiceProvider } from "./voice/VoiceProvider.js";
import type { VideoProvider } from "./video/VideoProvider.js";
import type { ImageProvider } from "./image/ImageProvider.js";
import { ClaudeProvider } from "./llm/ClaudeProvider.js";
import { ElevenLabsProvider } from "./voice/ElevenLabsProvider.js";
import { HeyGenProvider } from "./video/HeyGenProvider.js";
import { NanoBananaProvider } from "./image/NanoBananaProvider.js";
import { DynamicVideoProvider } from "./dynamic/DynamicVideoProvider.js";

/**
 * Punto único de instanciación de proveedores concretos a partir de config + credenciales.
 * Agregar un proveedor nuevo = añadir un case aquí, sin tocar el core.
 */
export interface Providers {
  llm: LLMProvider;
  /** null cuando providers.voice === "heygen" (la voz la maneja HeyGen vía voice_id). */
  voice: VoiceProvider | null;
  video: VideoProvider;
  /** null cuando providers.image === "none" (se usa la imagen del personaje tal cual). */
  image: ImageProvider | null;
  /** Motor de escenas dinámicas (Veo + voice changer); null si faltan GOOGLE/ELEVENLABS keys. */
  dynamic: DynamicVideoProvider | null;
}

export function createProviders(config: AppConfig, creds: Credentials): Providers {
  return {
    llm: createLLM(config, creds),
    voice: createVoice(config, creds),
    video: createVideo(config, creds),
    image: createImage(config, creds),
    dynamic: createDynamic(config, creds),
  };
}

function createDynamic(config: AppConfig, creds: Credentials): DynamicVideoProvider | null {
  if (!creds.googleApiKey || !creds.elevenLabsApiKey) return null;
  return new DynamicVideoProvider({
    googleApiKey: creds.googleApiKey,
    elevenLabsApiKey: creds.elevenLabsApiKey,
    veoModel: config.video.dynamic.veoModel,
    stsModel: config.video.dynamic.stsModel,
  });
}

function createLLM(config: AppConfig, creds: Credentials): LLMProvider {
  switch (config.providers.llm) {
    case "claude":
      return new ClaudeProvider({
        apiKey: creds.anthropicApiKey!,
        model: config.llm.model,
        maxTokens: config.llm.maxTokens,
      });
    default:
      throw new Error(`Proveedor LLM no soportado: ${config.providers.llm}`);
  }
}

function createVoice(config: AppConfig, creds: Credentials): VoiceProvider | null {
  switch (config.providers.voice) {
    case "heygen":
      return null; // la voz la sintetiza HeyGen con el voice_id del personaje
    case "elevenlabs":
      return new ElevenLabsProvider({ apiKey: creds.elevenLabsApiKey! });
    default:
      throw new Error(`Proveedor de voz no soportado: ${config.providers.voice}`);
  }
}

function createVideo(config: AppConfig, creds: Credentials): VideoProvider {
  switch (config.providers.video) {
    case "heygen":
      return new HeyGenProvider({ apiKey: creds.heygenApiKey! });
    default:
      throw new Error(`Proveedor de video no soportado: ${config.providers.video}`);
  }
}

function createImage(config: AppConfig, creds: Credentials): ImageProvider | null {
  switch (config.providers.image) {
    case "none":
      return null;
    case "nano-banana":
      return new NanoBananaProvider({
        apiKey: creds.googleApiKey!,
        model: config.image.model,
        resolution: config.image.resolution,
      });
    // case "fal": ... case "openai": ... case "kie": ...
    default:
      throw new Error(
        `Proveedor de imagen no implementado aún: ${config.providers.image}. ` +
          `Usa "none" (imagen del personaje tal cual) o "nano-banana".`,
      );
  }
}
