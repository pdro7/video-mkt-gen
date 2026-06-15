import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Librería de zonas (decorados reutilizables): id -> descripción.
 * Es un activo de marca COMPARTIDO entre todos los videos del cliente; vive fuera del spec
 * para que el guion solo referencie zonas por id (no las redefina en cada video).
 */
const zoneLibrarySchema = z.record(z.string());
export type ZoneLibrary = z.infer<typeof zoneLibrarySchema>;

/** Carga la librería de zonas desde un archivo JSON (id -> descripción). Vacía si no existe. */
export function loadZoneLibrary(path: string): ZoneLibrary {
  const abs = resolve(path);
  if (!existsSync(abs)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`zones.json no es JSON válido (${abs}): ${(e as Error).message}`);
  }
  const result = zoneLibrarySchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`zones.json inválido: debe ser un objeto { "ZONE_ID": "descripción", ... }`);
  }
  return result.data;
}
