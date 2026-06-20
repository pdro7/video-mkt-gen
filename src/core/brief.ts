import { z } from "zod";

/**
 * CourseBrief: la entrada por curso. Es el "qué" creativo de alto nivel a partir del
 * cual Claude genera el ProductionSpec completo. Es deliberadamente pequeño: el resto
 * (personajes, voces, imágenes) sale de config.json.
 */
export const courseBriefSchema = z.object({
  course_category: z.string().min(1),
  course_url: z.string().optional(),
  /**
   * URL de la FICHA del curso (página web). FUENTE PRINCIPAL: se descarga y su contenido
   * (temario, duración, precio, Fundae, público, beneficios) alimenta a Claude para el guion.
   */
  source_url: z.string().url().optional(),
  /** Objetivo del video: conversion, awareness, etc. */
  purpose: z.string().default("conversion"),
  language: z.string().default("es-ES"),
  version: z.string().optional(),
  /**
   * Transcript del video ACTUAL (OPCIONAL, apoyo). Si hay source_url, la ficha manda;
   * el transcript sirve para afinar el tono. Claude REESCRIBE, no copia.
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
  /** Proporción de escenas DINÁMICAS (con movimiento). 0.5 = la mitad. */
  dynamic_ratio: z.number().min(0).max(1).default(0.5),
  /** Tope absoluto opcional de dinámicas (para limitar coste de Veo); si se omite, manda dynamic_ratio. */
  max_dynamic_scenes: z.number().optional(),
});

export type CourseBrief = z.infer<typeof courseBriefSchema>;

export function parseCourseBrief(value: unknown): CourseBrief {
  return courseBriefSchema.parse(value);
}
