import type { CourseBrief } from "../../core/brief.js";
import type { ProductionSpec } from "../../core/spec.js";
import type { CharacterConfig } from "../../config/schema.js";

/**
 * Proveedor de LLM: genera el ProductionSpec completo a partir del brief y el roster
 * de personajes. El core depende solo de esta interfaz.
 */
export interface SpecGenerationContext {
  brief: CourseBrief;
  characters: CharacterConfig[];
  /** Librería de zonas disponibles (id -> descripción); Claude referencia por id, no inventa. */
  zones: Record<string, string>;
  constraints: { minScenes: number; maxScenes: number; wordsPerSecond: number };
  aspectRatio: string;
  client: string;
}

export interface LLMProvider {
  generateSpec(ctx: SpecGenerationContext): Promise<ProductionSpec>;
}
