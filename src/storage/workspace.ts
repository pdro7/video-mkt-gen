import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunManifest } from "../core/types.js";

/**
 * Workspace por corrida: guarda artefactos en output/<runId>/ para reanudar etapas
 * (spec -> images -> voice -> video) sin repetir trabajo.
 *
 *   output/<runId>/
 *     manifest.json
 *     spec.json
 *     images/scene-01.png ...
 *     audio/scene-01.mp3 ...
 *     videos/ (URLs en el manifiesto)
 */
export class Workspace {
  readonly runId: string;
  readonly root: string;

  constructor(outputDir: string, runId: string) {
    this.runId = runId;
    this.root = resolve(outputDir, runId);
    mkdirSync(this.imagesDir, { recursive: true });
    mkdirSync(this.audioDir, { recursive: true });
    mkdirSync(this.videosDir, { recursive: true });
  }

  get manifestPath(): string {
    return join(this.root, "manifest.json");
  }
  get specPath(): string {
    return join(this.root, "spec.json");
  }
  get imagesDir(): string {
    return join(this.root, "images");
  }
  get audioDir(): string {
    return join(this.root, "audio");
  }
  get videosDir(): string {
    return join(this.root, "videos");
  }

  /** Imagen por base_image (reutilizada en varias escenas), p. ej. images/IMG_1.png. */
  baseImagePath(baseImageId: string): string {
    return join(this.imagesDir, `${safe(baseImageId)}.png`);
  }
  audioPath(sceneId: number): string {
    return join(this.audioDir, `scene-${pad(sceneId)}.mp3`);
  }
  videoPath(sceneId: number): string {
    return join(this.videosDir, `scene-${pad(sceneId)}.mp4`);
  }

  hasBaseImage(baseImageId: string): boolean {
    return existsSync(this.baseImagePath(baseImageId));
  }
  hasAudio(sceneId: number): boolean {
    return existsSync(this.audioPath(sceneId));
  }

  saveBaseImage(baseImageId: string, data: Buffer): string {
    const p = this.baseImagePath(baseImageId);
    writeFileSync(p, data);
    return p;
  }
  saveAudio(sceneId: number, data: Buffer): string {
    const p = this.audioPath(sceneId);
    writeFileSync(p, data);
    return p;
  }
  saveVideo(sceneId: number, data: Buffer): string {
    const p = this.videoPath(sceneId);
    writeFileSync(p, data);
    return p;
  }

  loadManifest(): RunManifest {
    return JSON.parse(readFileSync(this.manifestPath, "utf8")) as RunManifest;
  }

  saveManifest(manifest: RunManifest): void {
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    if (manifest.spec) {
      writeFileSync(this.specPath, JSON.stringify(manifest.spec, null, 2), "utf8");
    }
  }
}

/** Genera un runId legible y ordenable a partir de un timestamp inyectado. */
export function makeRunId(date: Date): string {
  const iso = date.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `run_${iso}`;
}

/** Resuelve un workspace existente por runId (para reanudar etapas). */
export function openWorkspace(outputDir: string, runId: string): Workspace {
  const ws = new Workspace(outputDir, runId);
  if (!existsSync(ws.manifestPath)) {
    throw new Error(`No existe un manifiesto para la corrida "${runId}" en ${ws.root}`);
  }
  return ws;
}

/** Lista las corridas disponibles en el directorio de salida. */
export function listRuns(outputDir: string): string[] {
  const abs = resolve(outputDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Sanitiza un id para usarlo como nombre de archivo. */
function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
