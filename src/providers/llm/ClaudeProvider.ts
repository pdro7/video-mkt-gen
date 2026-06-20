import Anthropic from "@anthropic-ai/sdk";
import { enforceDynamicSceneCount, productionSpecSchema, type ProductionSpec } from "../../core/spec.js";
import { buildSpecPrompt } from "../../prompts/scenePlanner.js";
import { createLogger } from "../../util/logger.js";
import { withRetry } from "../../util/retry.js";
import type { LLMProvider, SpecGenerationContext } from "./LLMProvider.js";

const log = createLogger("claude");

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export class ClaudeProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(opts: ClaudeProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
  }

  async generateSpec(ctx: SpecGenerationContext): Promise<ProductionSpec> {
    const { system, user } = buildSpecPrompt(ctx);
    const validIds = new Set(ctx.characters.map((c) => c.id));

    let feedback = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      log.info(`Generando spec de producción (intento ${attempt})...`);
      const message = await withRetry(
        () =>
          this.client.messages.create({
            model: this.model,
            max_tokens: this.maxTokens,
            system,
            messages: [{ role: "user", content: feedback ? `${user}\n\n# Corrige esto\n${feedback}` : user }],
          }),
        "claude messages",
      );

      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const parsed = productionSpecSchema.safeParse(extractJson(text));
      if (!parsed.success) {
        feedback = `El JSON no respetó el formato: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`;
        log.warn(feedback);
        continue;
      }

      const problems = validateSpec(parsed.data, ctx, validIds);
      if (problems.length === 0) {
        // Guard determinista de TTS: vocales idénticas pegadas que el sintetizador pronuncia mal.
        const tts = findVowelCollisions(parsed.data);
        if (tts.length > 0 && attempt < 2) {
          feedback = `Reescribe estas frases para evitar el CHOQUE DE VOCALES IDÉNTICAS entre palabras (el TTS lo pronuncia mal); mantén el sentido:\n${tts
            .map((t) => `- escena ${t.id}: "...${t.pair}..." en «${t.dialogue}»`)
            .join("\n")}`;
          log.warn(`Reintentando por TTS (choque de vocales): ${tts.map((t) => t.pair).join(", ")}`);
          continue;
        }
        if (tts.length > 0) {
          log.warn(`Persisten posibles choques de vocales TTS (acepto el spec): ${tts.map((t) => t.pair).join(", ")}`);
        }
        const n = parsed.data.scenes.length;
        let target = Math.round(n * ctx.brief.dynamic_ratio);
        if (ctx.brief.max_dynamic_scenes != null) target = Math.min(target, ctx.brief.max_dynamic_scenes);
        if (n >= 2) target = Math.max(target, 2); // apertura + cierre siempre dinámicas
        enforceDynamicSceneCount(parsed.data, target);
        const dyn = parsed.data.scenes.filter((s) => s.motion).length;
        log.info(`Spec OK: ${n} escenas (${dyn} dinámicas, objetivo ${target}).`);
        return parsed.data;
      }
      feedback = `El spec no cumple las reglas:\n${problems.map((p) => `- ${p}`).join("\n")}`;
      log.warn(`Reintentando. ${feedback}`);
    }

    throw new Error("No se pudo generar un ProductionSpec válido tras 2 intentos.");
  }
}

const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const stripAccents = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Detecta CHOQUES DE VOCALES IDÉNTICAS entre palabras (hiato que el TTS pronuncia mal), p. ej.
 * "a automatizar", "vas a aprenderlo", "su universo". Normaliza acentos y la "h" muda inicial.
 * Devuelve por escena el par de palabras problemático.
 */
function findVowelCollisions(spec: ProductionSpec): Array<{ id: number; pair: string; dialogue: string }> {
  const hits: Array<{ id: number; pair: string; dialogue: string }> = [];
  for (const scene of spec.scenes) {
    const raw = (scene.dialogue ?? "").split(/\s+/);
    const words = raw
      .map((w) => stripAccents(w.toLowerCase()).replace(/[^a-zñü]/g, ""))
      .filter(Boolean);
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i]!;
      let b = words[i + 1]!;
      if (b.startsWith("h")) b = b.slice(1); // "h" muda: "la hamaca" -> a+a
      const last = a[a.length - 1]!;
      const first = b[0];
      if (first && VOWELS.has(last) && VOWELS.has(first) && last === first) {
        hits.push({ id: scene.id, pair: `${raw[i]} ${raw[i + 1]}`, dialogue: scene.dialogue ?? "" });
      }
    }
  }
  return hits;
}

function validateSpec(spec: ProductionSpec, ctx: SpecGenerationContext, validIds: Set<string>): string[] {
  const problems: string[] = [];
  const n = spec.scenes.length;
  if (n < ctx.constraints.minScenes || n > ctx.constraints.maxScenes) {
    problems.push(`Debe haber entre ${ctx.constraints.minScenes} y ${ctx.constraints.maxScenes} escenas (hay ${n}).`);
  }
  const baseImageIds = new Set(Object.keys(spec.base_images));
  for (const s of spec.scenes) {
    // En v2 el personaje se deriva del base_image; validamos la referencia al base_image.
    if (!baseImageIds.has(s.base_image)) {
      problems.push(`Escena ${s.id}: base_image inexistente "${s.base_image}".`);
    }
  }
  for (const [imgId, img] of Object.entries(spec.base_images)) {
    if (!validIds.has(img.character)) {
      problems.push(`base_image ${imgId}: personaje inexistente "${img.character}".`);
    }
  }
  return problems;
}

/** Extrae el primer objeto JSON del texto, tolerando fences accidentales. */
function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("La respuesta del LLM no contenía JSON parseable.");
  }
}
