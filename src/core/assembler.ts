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
  /** Si true, aplica mejora/limpieza de audio al final (highpass + loudnorm + presencia). */
  cleanAudio?: boolean;
}

/** Cadena de filtros de mejora/limpieza de audio (ver scripts/clean-audio.mjs). */
const CLEAN_AUDIO_AF = "highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=11,equalizer=f=3500:t=q:w=1.2:g=2";

/**
 * Une los clips de escena en un solo mp4. Como vienen de fuentes distintas (HeyGen 1080p,
 * Veo/fal ~720p), primero NORMALIZA cada uno a la misma resolución/fps/SAR/audio y luego
 * concatena por demuxer (copia directa, sin re-encode del concat). Requiere ffmpeg en el PATH.
 */
export async function assembleFinalVideo({ clips, outPath, width, height, fps = 25, cleanAudio = false }: AssembleInput): Promise<void> {
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
  // Concat por demuxer (copia directa). Si hay limpieza de audio, va a un temporal y se re-encoda el audio.
  const concatOut = cleanAudio ? join(tmp, "concat.mp4") : outPath;
  await run("ffmpeg", [
    "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart", concatOut,
  ]);
  if (cleanAudio) {
    await run("ffmpeg", [
      "-nostdin", "-y", "-v", "error", "-i", concatOut,
      "-c:v", "copy", "-af", CLEAN_AUDIO_AF,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", outPath,
    ]);
    log.info(`Audio final mejorado (highpass + loudnorm + presencia).`);
  }
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
