import { z } from "zod";
import { adaptLegacySpec, looksLegacy } from "./legacyAdapter.js";

/**
 * ProductionSpec v2 — formato canónico (plano, sin credenciales, nombres neutrales).
 *
 * Estructura (todo a nivel raíz):
 *   schema_version: 2
 *   video         -> metadatos (cliente, curso, idioma, aspect ratio, estimación)
 *   characters    -> SOLO datos creativos (la voz/imagen se enlaza por id en config.json)
 *   zones         -> entornos reutilizables (id -> descripción)
 *   base_images   -> toma encuadrada (character + zone + framing) reutilizada en escenas
 *   scenes        -> acción por escena; zona/encuadre/personaje se derivan del base_image
 *   brand_assets  -> registro opcional de logos/badges referenciados por persistent_overlays
 *
 * Los tiempos (estimated_seconds, overlay start/end) son ESTIMACIONES/relativos: la duración
 * real la define el motor de video según el habla. Overlays/transiciones/cámara = etapa 2.
 */

const expressiveness = z.enum(["high", "medium", "low"]);

export const characterSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  gender: z.string().optional(),
  age_range: z.string().optional(),
  wardrobe: z.string().optional(),
});

export const baseImageSpecSchema = z.object({
  character: z.string(),
  zone: z.string().optional(),
  framing: z.string().optional(),
  used_in_scenes: z.array(z.number()).default([]),
});

/** Overlay con tiempos RELATIVOS al inicio de su escena (start/end en segundos). */
export const overlaySpecSchema = z
  .object({
    type: z.string(),
    content: z.union([z.string(), z.array(z.string())]).optional(),
    position: z.string().optional(),
    start: z.number().optional(),
    end: z.number().optional(),
    style: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const sceneSpecSchema = z.object({
  id: z.number(),
  base_image: z.string(),
  dialogue: z.string().min(1),
  tone: z.string().optional(),
  emphasis_words: z.array(z.string()).default([]),
  motion_prompt: z.string().optional(),
  expressiveness: expressiveness.optional(),
  /**
   * Si está presente, la escena es DINÁMICA (avatar en movimiento) y se renderiza con el
   * motor dinámico (Veo reference-to-video + voice changer) en vez de HeyGen. El texto
   * describe el movimiento para Veo (p. ej. "plano medio, movimiento natural y gestos").
   */
  motion: z.string().optional(),
  estimated_seconds: z.number().optional(),
  transition_in: z.string().optional(),
  transition_out: z.string().optional(),
  camera_movement: z.record(z.unknown()).optional(),
  overlays: z.array(overlaySpecSchema).default([]),
  persistent_overlays: z.array(z.string()).default([]),
});

export const productionSpecSchema = z.object({
  schema_version: z.number().default(2),
  video: z.object({
    client: z.string(),
    course_category: z.string(),
    course_url: z.string().optional(),
    course_id: z.string().optional(),
    language: z.string().default("es-ES"),
    /** Versión del spot (A/B), distinto de schema_version. */
    version: z.string().optional(),
    purpose: z.string().optional(),
    aspect_ratio: z.string().default("16:9"),
    estimated_seconds: z.number().optional(),
  }),
  characters: z.record(characterSpecSchema).default({}),
  zones: z.record(z.string()).default({}),
  base_images: z.record(baseImageSpecSchema).default({}),
  scenes: z.array(sceneSpecSchema).min(1),
  brand_assets: z.record(z.record(z.unknown())).default({}),
});

export type ProductionSpec = z.infer<typeof productionSpecSchema>;
export type SceneSpec = z.infer<typeof sceneSpecSchema>;
export type BaseImageSpec = z.infer<typeof baseImageSpecSchema>;
export type CharacterSpec = z.infer<typeof characterSpecSchema>;
export type OverlaySpec = z.infer<typeof overlaySpecSchema>;

/**
 * Parsea/valida un ProductionSpec. Acepta el formato v2 directamente o el legacy (v1,
 * como script_sample.json): si detecta legacy, lo adapta a v2 antes de validar.
 */
export function parseProductionSpec(value: unknown): ProductionSpec {
  const normalized = looksLegacy(value) ? adaptLegacySpec(value) : value;
  return productionSpecSchema.parse(normalized);
}

/** Pool de movimientos estilo A (plano medio favorecedor) — respaldo cuando Claude no
 *  redactó un `motion` para una escena seleccionada. Se asignan variados por índice. */
const DEFAULT_DYNAMIC_MOTIONS = [
  "in a flattering medium shot, with a gentle slow push-in and subtle hand gestures",
  "in a flattering medium shot, taking a couple of confident steps toward the camera",
  "in a flattering medium shot, with a slow lateral camera drift and natural upper-body movement",
  "in a flattering medium shot, leaning in slightly with an open-hand gesture and a soft push-in",
  "in a flattering medium shot, a slow arc toward the camera with relaxed confident posture",
  "in a flattering medium shot, energetic delivery with expressive hand gestures and a gentle push-in",
];

/**
 * Garantiza un número determinista de escenas dinámicas (con `motion`): incluye SIEMPRE la
 * primera y la última, y reparte el resto de forma equiespaciada. A las seleccionadas que no
 * traen `motion` les pone uno por defecto (estilo A); a las no seleccionadas les quita `motion`.
 */
export function enforceDynamicSceneCount(spec: ProductionSpec, target: number): void {
  const n = spec.scenes.length;
  const k = Math.max(0, Math.min(Math.floor(target), n));
  const selected = new Set<number>();
  if (k >= n) {
    for (let i = 0; i < n; i++) selected.add(i);
  } else if (k === 1) {
    selected.add(0);
  } else if (k > 1) {
    for (let i = 0; i < k; i++) selected.add(Math.round((i * (n - 1)) / (k - 1)));
  }
  let fallbackIdx = 0;
  spec.scenes.forEach((s, i) => {
    if (selected.has(i)) {
      // Si Claude no escribió un motion a medida, usar el pool variado (distinto por escena).
      if (!s.motion) s.motion = DEFAULT_DYNAMIC_MOTIONS[fallbackIdx++ % DEFAULT_DYNAMIC_MOTIONS.length];
    } else if (s.motion) {
      delete s.motion;
    }
  });
}

/** Id del personaje de una escena (derivado de su base_image). */
export function sceneCharacterId(spec: ProductionSpec, scene: SceneSpec): string {
  const base = spec.base_images[scene.base_image];
  if (!base) throw new Error(`La escena ${scene.id} referencia un base_image inexistente: "${scene.base_image}".`);
  return base.character;
}
