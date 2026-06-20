import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunManifest } from "../core/types.js";

/**
 * Genera una "hoja de escenas" HTML por run: una miniatura (fotograma intermedio) de cada
 * escena con su timecode, personaje, tipo y diálogo. Las miniaturas se cachean (se omite la
 * extracción si ya existen). Devuelve la ruta relativa al HTML (respecto a output/) o null.
 */

const esc = (s: string): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const tc = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function probeDuration(file: string): number {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" },
    );
    return parseFloat(out.trim()) || 0;
  } catch {
    return 0;
  }
}

function extractThumb(video: string, outJpg: string, atSec: number): boolean {
  try {
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-ss", String(atSec.toFixed(3)), "-i", video,
      "-frames:v", "1", "-vf", "scale=480:-1", outJpg,
    ]);
    return existsSync(outJpg);
  } catch {
    return false;
  }
}

interface Row {
  id: number;
  nn: string;
  start: number;
  end: number;
  chars: string[];
  duo: boolean;
  dialogue: string;
  prompt?: string;
  imgPrompt?: string;
}

export function writeSceneSheet(runDir: string, manifest: RunManifest): string | null {
  const scenes = manifest.spec?.scenes ?? [];
  if (!scenes.length) return null;
  const videosDir = join(runDir, "videos");
  const sheetDir = join(runDir, "scene-sheet");
  const thumbsDir = join(sheetDir, "thumbs");
  mkdirSync(thumbsDir, { recursive: true });

  let cum = 0;
  const rows: Row[] = [];
  for (const s of scenes) {
    const nn = String(s.id).padStart(2, "0");
    const clip = join(videosDir, `scene-${nn}.mp4`);
    if (!existsSync(clip)) continue; // escena no renderizada todavía
    const dur = probeDuration(clip);
    const thumb = join(thumbsDir, `scene-${nn}.jpg`);
    if (!existsSync(thumb)) extractThumb(clip, thumb, Math.max(0, dur / 2));
    const duo = Boolean(s.cast && s.cast.length > 1);
    const chars = duo
      ? s.cast!.map((c) => c.character)
      : [manifest.spec?.base_images?.[s.base_image]?.character ?? ""];
    const dialogue = duo ? s.cast!.map((c) => `${cap(c.character)}: ${c.dialogue}`).join("  /  ") : s.dialogue ?? "";
    const prompt = manifest.videos?.find((v) => v.sceneId === s.id)?.prompt;
    const imgPrompt = manifest.images?.find((i) => i.baseImageId === s.base_image)?.prompt;
    rows.push({ id: s.id, nn, start: cum, end: cum + dur, chars, duo, dialogue, prompt, imgPrompt });
    cum += dur;
  }
  if (!rows.length) return null;

  const trs = rows
    .map((r) => {
      const chars = r.chars.map(cap).join(" + ");
      const tipo = r.duo ? "Dúo" : "Dinámica";
      const img = existsSync(join(thumbsDir, `scene-${r.nn}.jpg`))
        ? `<img src="thumbs/scene-${r.nn}.jpg" alt="escena ${r.id}">`
        : '<span class="muted">—</span>';
      const vidLabel = r.duo ? "🎬 Prompt dúo (HeyGen Cinematic)" : "🎬 Prompt vídeo (Veo)";
      const promptHtml = r.prompt
        ? `<details class="prompt"><summary>${vidLabel}</summary><div>${esc(r.prompt)}</div></details>`
        : "";
      const imgPromptHtml = r.imgPrompt
        ? `<details class="prompt img"><summary>🖼️ Prompt imagen base (Nano Banana)</summary><div>${esc(r.imgPrompt)}</div></details>`
        : "";
      return `<tr>
      <td class="n">${r.id}</td>
      <td class="tc">${tc(r.start)}–${tc(r.end)}</td>
      <td>${img}</td>
      <td class="ch">${esc(chars)}</td>
      <td>${tipo}</td>
      <td class="dlg">${esc(r.dialogue)}${promptHtml}${imgPromptHtml}</td>
    </tr>`;
    })
    .join("\n");

  const title = manifest.brief?.course_category ?? manifest.runId;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hoja de escenas — ${esc(title)}</title>
<style>
body{margin:0;background:#f6f7f9;color:#1c2430;font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:28px 20px}
h1{margin:0 0 4px}.sub{color:#6b7480;margin:0 0 14px}
a.back{color:#2a52a8;text-decoration:none;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
th,td{padding:10px 12px;border-bottom:1px solid #eef0f3;text-align:left;vertical-align:middle}
th{background:#f0f2f4;font-size:13px}
td.n{font-weight:700;font-size:18px;color:#2a52a8}
td.tc{font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:nowrap;color:#445}
img{width:200px;border-radius:6px;display:block}
td.ch{white-space:nowrap;font-weight:600}
td.dlg{font-size:13.5px;color:#333}
details.prompt{margin-top:8px}
details.prompt summary{cursor:pointer;color:#7a2aa8;font-size:12px;font-weight:600}
details.prompt div{margin-top:6px;padding:8px 10px;background:#faf6ff;border:1px solid #ecdcff;border-radius:6px;font-size:12px;color:#444;line-height:1.45;white-space:pre-wrap}
details.prompt.img summary{color:#2a52a8}
details.prompt.img div{background:#f4f8ff;border-color:#cfe0fb}
.muted{color:#b8bec6}
@media print{body{background:#fff}.wrap{max-width:none}}
</style></head><body><div class="wrap">
<a class="back" href="../../catalogo.html">← Catálogo</a>
<h1>Hoja de escenas — ${esc(title)}</h1>
<p class="sub">${rows.length} escenas · timecodes a velocidad normal · <span class="muted">${esc(manifest.runId)}</span></p>
<table>
<thead><tr><th>#</th><th>Tiempo</th><th>Fotograma</th><th>Personaje</th><th>Tipo</th><th>Diálogo</th></tr></thead>
<tbody>
${trs}
</tbody></table>
</div></body></html>`;
  writeFileSync(join(sheetDir, "scene-sheet.html"), html, "utf8");
  return `${basename(runDir)}/scene-sheet/scene-sheet.html`;
}
