import type { CourseBrief } from "./brief.js";
import type { ProductionSpec } from "./spec.js";

/**
 * Tipos de artefactos producidos por el pipeline. El spec creativo vive en spec.ts;
 * aquí están los resultados de render (imagen base resuelta, audio, video) y el
 * manifiesto que permite reanudar etapas.
 */

/**
 * Imagen base generada/resuelta UNA vez por `base_image` y reutilizada en todas sus
 * `used_in_scenes` (clave del diseño: escenas que comparten base se ven idénticas).
 */
export interface BaseImage {
  baseImageId: string;
  characterId: string;
  filePath: string;
  mimeType: string;
  /** Imagen de referencia del avatar que se adjunta al request (de config). */
  referenceImagePath?: string;
  /** Prompt de texto enviado al modelo de imagen (la imagen de referencia va aparte). */
  prompt?: string;
  /** Tiempo de generación de esta imagen en segundos (undefined si se reusó/existía). */
  genSeconds?: number;
}

/** Audio (ElevenLabs) generado para una escena. */
export interface SceneAudio {
  sceneId: number;
  filePath: string;
  /** Duración real del audio en segundos, si el proveedor la informa. */
  durationSeconds?: number;
}

export type SceneVideoStatus = "pending" | "processing" | "completed" | "failed";

/** Video (HeyGen) generado para una escena. */
export interface SceneVideo {
  sceneId: number;
  status: SceneVideoStatus;
  providerJobId?: string;
  videoUrl?: string;
  filePath?: string;
  error?: string;
  /** Tiempo total de creación del video en segundos (subida + render + descarga). */
  genSeconds?: number;
}

/** Manifiesto persistido por corrida: permite reanudar (spec -> images -> voice -> video). */
export interface RunManifest {
  runId: string;
  createdAt: string;
  /** Cómo se obtuvo el spec: generado por Claude desde un brief, o ingerido tal cual. */
  source: "claude" | "ingested";
  brief?: CourseBrief;
  spec?: ProductionSpec;
  images?: BaseImage[];
  audio?: SceneAudio[];
  videos?: SceneVideo[];
}
