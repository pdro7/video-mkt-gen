import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { appConfigSchema, type AppConfig } from "./schema.js";

dotenv.config({ quiet: true });

/** Credenciales leídas de variables de entorno. Único lugar donde viven los secretos. */
export interface Credentials {
  anthropicApiKey?: string;
  elevenLabsApiKey?: string;
  heygenApiKey?: string;
  googleApiKey?: string;
  falKey?: string;
  openaiApiKey?: string;
  kieApiKey?: string;
  syncApiKey?: string;
}

export function loadCredentials(): Credentials {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
    heygenApiKey: process.env.HEYGEN_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    falKey: process.env.FAL_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    kieApiKey: process.env.KIE_API_KEY,
    syncApiKey: process.env.SYNC_API_KEY,
  };
}

/** Carga y valida config.json. Lanza un error legible si la config es inválida. */
export function loadConfig(configPath: string): AppConfig {
  const abs = resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`No se pudo leer el archivo de configuración: ${abs}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config.json no es JSON válido: ${(e as Error).message}`);
  }

  const result = appConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`config.json inválido:\n${issues}`);
  }
  return result.data;
}

/** Verifica credenciales requeridas por los proveedores seleccionados. */
export function assertCredentialsForConfig(config: AppConfig, creds: Credentials): void {
  const missing: string[] = [];

  if (config.providers.llm === "claude" && !creds.anthropicApiKey) {
    missing.push("ANTHROPIC_API_KEY (LLM claude)");
  }
  // El camino por defecto "heygen" NO requiere clave de ElevenLabs (HeyGen la maneja).
  if (config.providers.voice === "elevenlabs" && !creds.elevenLabsApiKey) {
    missing.push("ELEVENLABS_API_KEY (voz elevenlabs)");
  }
  if (config.providers.video === "heygen" && !creds.heygenApiKey) {
    missing.push("HEYGEN_API_KEY (video heygen)");
  }
  if (config.providers.image === "nano-banana" && !creds.googleApiKey) {
    missing.push("GOOGLE_API_KEY (image nano-banana)");
  }
  if (config.providers.image === "fal" && !creds.falKey) missing.push("FAL_KEY (image fal)");
  if (config.providers.image === "openai" && !creds.openaiApiKey) missing.push("OPENAI_API_KEY (image openai)");
  if (config.providers.image === "kie" && !creds.kieApiKey) missing.push("KIE_API_KEY (image kie)");

  // Motor de escenas dinámicas: la generación del clip depende del provider elegido.
  if (config.video.dynamic.provider === "fal" && !creds.falKey) missing.push("FAL_KEY (video dinámico fal)");
  if (config.video.dynamic.provider === "heygen-shot" && !creds.heygenApiKey) {
    missing.push("HEYGEN_API_KEY (video dinámico heygen-shot)");
  }
  // Sync: Veo (vía fal) para el visual + Sync para TTS+lip-sync.
  if (config.video.dynamic.provider === "sync") {
    if (!creds.falKey) missing.push("FAL_KEY (video dinámico sync: visual con Veo)");
    if (!creds.syncApiKey) missing.push("SYNC_API_KEY (video dinámico sync: lip-sync)");
    // Con ttsSpeed != 1 generamos el TTS con ElevenLabs (necesita su clave).
    if (config.video.dynamic.ttsSpeed !== 1 && !creds.elevenLabsApiKey) {
      missing.push("ELEVENLABS_API_KEY (video dinámico sync: TTS con speed)");
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Faltan credenciales en el entorno (.env):\n${missing.map((m) => `  - ${m}`).join("\n")}`,
    );
  }
}
