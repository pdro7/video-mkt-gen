import type { AppConfig } from "../config/schema.js";
import type { RunManifest } from "./types.js";

/**
 * Estimación de coste de GENERACIÓN (API) por run, calculada desde el manifest.
 * Refleja el coste de los CLIPS FINALES (una pasada); NO incluye re-tiradas/iteraciones
 * (esas no quedan registradas en el manifest). Varios unitarios son estimados — ajusta
 * UNIT_COSTS o config.pricing si tienes datos exactos.
 */
export interface CostLine {
  label: string;
  qty: number;
  unit: number;
  subtotal: number;
}
export interface CostEstimate {
  total: number;
  currency: "USD";
  lines: CostLine[];
  /** Aviso de que es estimado y no cuenta iteraciones. */
  note: string;
  computedAt: string;
}

/** Precios unitarios por defecto (USD). Coinciden con la guía (sección Costes). */
export const UNIT_COSTS = {
  spec: 0.4, // Claude por vídeo
  imageBase: 0.12, // Nano Banana Pro por imagen
  talkingHead: 0.1, // HeyGen Avatar IV por escena
  voicePerScene: 0.07, // ElevenLabs TTS/STS por escena
  dynamicFalFast: 1.2, // Veo fast (fal) por clip
  dynamicFalStd: 3.2, // Veo std/quality (fal) por clip
  dynamicGemini: 1.2, // Veo vía Gemini directo por clip
  heygenShot: { "720p": 4.88, "1080p": 12.0 } as Record<string, number>,
};

/** Precio de una escena dinámica (Veo) según el motor configurado. */
function dynamicUnit(config: AppConfig): number {
  const d = config.video?.dynamic;
  if (!d) return UNIT_COSTS.dynamicFalFast;
  if (d.provider === "fal") return /fast/i.test(d.falModel ?? "") ? UNIT_COSTS.dynamicFalFast : UNIT_COSTS.dynamicFalStd;
  if (d.provider === "heygen-shot") return UNIT_COSTS.heygenShot[d.shotResolution ?? "720p"] ?? UNIT_COSTS.heygenShot["720p"]!;
  return UNIT_COSTS.dynamicGemini; // gemini
}

/** Cuenta escenas por tipo y calcula el desglose de coste. */
export function computeRunCost(manifest: RunManifest, config: AppConfig, now = new Date().toISOString()): CostEstimate {
  const scenes = manifest.spec?.scenes ?? [];
  const images = Object.keys(manifest.spec?.base_images ?? {}).length;
  // Resolución de HeyGen Cinematic para escenas multi-avatar (cast).
  const shotRes = config.video?.dynamic?.shotResolution ?? "720p";
  const duoUnit = UNIT_COSTS.heygenShot[shotRes] ?? UNIT_COSTS.heygenShot["720p"]!;
  const dynUnit = dynamicUnit(config);

  let duo = 0,
    dynamic = 0,
    talkingHead = 0,
    voice = 0;
  for (const s of scenes) {
    if (s.cast && s.cast.length > 1) duo++;
    else if (s.motion) dynamic++;
    else talkingHead++;
    if (s.dialogue || (s.cast && s.cast.length)) voice++;
  }
  // El dúo/Cinematic usa voz nativa (sin coste extra de ElevenLabs).
  const voiceScenes = voice - duo;

  const raw: CostLine[] = [
    { label: "Spec (Claude)", qty: scenes.length ? 1 : 0, unit: UNIT_COSTS.spec, subtotal: 0 },
    { label: "Imágenes base (Nano Banana)", qty: images, unit: UNIT_COSTS.imageBase, subtotal: 0 },
    { label: "Dinámicas (Veo)", qty: dynamic, unit: dynUnit, subtotal: 0 },
    { label: `Dúo / Cinematic (HeyGen ${shotRes})`, qty: duo, unit: duoUnit, subtotal: 0 },
    { label: "Talking-head (HeyGen Avatar IV)", qty: talkingHead, unit: UNIT_COSTS.talkingHead, subtotal: 0 },
    { label: "Voz (ElevenLabs TTS/STS)", qty: Math.max(0, voiceScenes), unit: UNIT_COSTS.voicePerScene, subtotal: 0 },
  ];
  const lines = raw.filter((l) => l.qty > 0).map((l) => ({ ...l, subtotal: round(l.qty * l.unit) }));
  const total = round(lines.reduce((a, l) => a + l.subtotal, 0));
  return {
    total,
    currency: "USD",
    lines,
    note: "Coste de generación (API) de los clips finales. No incluye re-tiradas/iteraciones, suscripciones, tiempo de operación ni margen. Unitarios parcialmente estimados.",
    computedAt: now,
  };
}

const round = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => `$${n.toFixed(2)}`;

/** Render de costs.md para un run. */
export function renderCostsMarkdown(runId: string, est: CostEstimate): string {
  const rows = est.lines
    .map((l) => `| ${l.label} | ${l.qty} | ${fmt(l.unit)} | ${fmt(l.subtotal)} |`)
    .join("\n");
  return `# Coste estimado — ${runId}

| Componente | Cantidad | Unitario | Subtotal |
|---|---:|---:|---:|
${rows}
| **TOTAL (generación API)** | | | **${fmt(est.total)}** |

> ${est.note}
>
> Generado: ${est.computedAt}
`;
}
