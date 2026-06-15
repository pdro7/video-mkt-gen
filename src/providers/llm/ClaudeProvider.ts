import Anthropic from "@anthropic-ai/sdk";
import { enforceDynamicSceneCount, productionSpecSchema, type ProductionSpec } from "../../core/spec.js";
import { buildSpecPrompt } from "../../prompts/scenePlanner.js";
import { createLogger } from "../../util/logger.js";
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
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages: [{ role: "user", content: feedback ? `${user}\n\n# Corrige esto\n${feedback}` : user }],
      });

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
        enforceDynamicSceneCount(parsed.data, ctx.brief.max_dynamic_scenes);
        const dyn = parsed.data.scenes.filter((s) => s.motion).length;
        log.info(`Spec OK: ${parsed.data.scenes.length} escenas (${dyn} dinámicas).`);
        return parsed.data;
      }
      feedback = `El spec no cumple las reglas:\n${problems.map((p) => `- ${p}`).join("\n")}`;
      log.warn(`Reintentando. ${feedback}`);
    }

    throw new Error("No se pudo generar un ProductionSpec válido tras 2 intentos.");
  }
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
