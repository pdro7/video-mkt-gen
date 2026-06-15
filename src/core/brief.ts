import { z } from "zod";

/**
 * CourseBrief: la entrada por curso. Es el "qué" creativo de alto nivel a partir del
 * cual Claude genera el ProductionSpec completo. Es deliberadamente pequeño: el resto
 * (personajes, voces, imágenes) sale de config.json.
 */
export const courseBriefSchema = z.object({
  course_category: z.string().min(1),
  course_url: z.string().optional(),
  /** Objetivo del video: conversion, awareness, etc. */
  purpose: z.string().default("conversion"),
  language: z.string().default("es-ES"),
  version: z.string().optional(),
  /**
   * Transcript del video ACTUAL de la categoría. Es la entrada principal: Claude lo
   * REESCRIBE para hacerlo más vendedor (sin inventar datos) y luego lo estructura en escenas.
   */
  current_transcript: z.string().optional(),
  /** Mensaje/ganchos clave adicionales (opcional, complementa el transcript). */
  key_message: z.string().optional(),
  /** Datos/argumentos extra que el video puede usar (opcional). */
  talking_points: z.array(z.string()).default([]),
  /** Ids de personajes (de config.json) que participan en este video. */
  character_ids: z.array(z.string()).min(1),
  /** Avatar protagonista (id de character_ids): lleva el peso del video (gancho y CTA). */
  protagonist: z.string().optional(),
  /** Nº de escenas objetivo (dentro de las restricciones de config). Opcional. */
  target_scenes: z.number().optional(),
  /** Máximo de escenas DINÁMICAS (con movimiento, motor Veo). Default 6 (apertura+cierre+~4). */
  max_dynamic_scenes: z.number().default(6),
});

export type CourseBrief = z.infer<typeof courseBriefSchema>;

export function parseCourseBrief(value: unknown): CourseBrief {
  return courseBriefSchema.parse(value);
}
