import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../util/logger.js";

const run = promisify(execFile);
const log = createLogger("assembler");

export interface AssembleInput {
  /** Rutas de los clips mp4 EN ORDEN. */
  clips: string[];
  /** Ruta del mp4 final. */
  outPath: string;
  width: number;
  height: number;
  fps?: number;
}

/**
 * Une los clips de escena en un solo mp4. Como vienen de fuentes distintas (HeyGen 1080p,
 * Veo/fal ~720p), primero NORMALIZA cada uno a la misma resolución/fps/SAR/audio y luego
 * concatena por demuxer (copia directa, sin re-encode del concat). Requiere ffmpeg en el PATH.
 */
export async function assembleFinalVideo({ clips, outPath, width, height, fps = 25 }: AssembleInput): Promise<void> {
  if (clips.length === 0) throw new Error("No hay clips para montar.");
  const tmp = mkdtempSync(join(tmpdir(), "assemble-"));
  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;

  const listLines: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const norm = join(tmp, `${String(i).padStart(3, "0")}.mp4`);
    await run("ffmpeg", [
      "-y", "-v", "error", "-i", clips[i]!,
      "-vf", vf,
      "-c:v", "libx264", "-preset", "medium", "-crf", "19",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      norm,
    ]);
    listLines.push(`file '${norm}'`);
  }

  const listPath = join(tmp, "list.txt");
  writeFileSync(listPath, listLines.join("\n") + "\n", "utf8");
  await run("ffmpeg", [
    "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart", outPath,
  ]);
  log.info(`Video final montado (${clips.length} escenas) -> ${outPath}`);
}

/** Dimensiones (w,h) a partir del nombre de resolución del config. */
export function resolutionDims(resolution: string): [number, number] {
  switch (resolution) {
    case "720p":
      return [1280, 720];
    case "4k":
      return [3840, 2160];
    default:
      return [1920, 1080];
  }
}
