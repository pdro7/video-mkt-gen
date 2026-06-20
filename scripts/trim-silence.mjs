// Recorta la cola de silencio final de clips sueltos. Por defecto usa el criterio del pipeline
// (cola >0.6s → cortar a fin_voz+0.4s). Con flags se puede ser más agresivo.
// Uso: node scripts/trim-silence.mjs [--d 0.4] [--tail 0.6] [--pad 0.4] <file1.mp4> [file2 ...]
import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = { d: 0.4, tail: 0.6, pad: 0.4 };
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--d") opt.d = parseFloat(args[++i]);
  else if (a === "--tail") opt.tail = parseFloat(args[++i]);
  else if (a === "--pad") opt.pad = parseFloat(args[++i]);
  else files.push(a);
}
if (!files.length) throw new Error("Uso: node scripts/trim-silence.mjs [--d N --tail N --pad N] <archivos.mp4...>");
console.log(`Criterio: silencedetect d=${opt.d}s · cola mínima ${opt.tail}s · margen ${opt.pad}s`);

const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" }).trim()) || 0;

function detectSpeechEnd(file, total) {
  // ffmpeg escribe silencedetect en STDERR y sale con código 0 → capturamos stderr con spawnSync.
  const r = spawnSync("ffmpeg", ["-nostdin", "-i", file, "-af", `silencedetect=noise=-30dB:d=${opt.d}`, "-f", "null", "-"], { encoding: "utf8" });
  const err = (r.stderr ?? "") + (r.stdout ?? "");
  const starts = [], ends = [];
  for (const m of err.matchAll(/silence_(start|end):\s*([\d.]+)/g)) (m[1] === "start" ? starts : ends).push(parseFloat(m[2]));
  if (!starts.length) return null;
  const lastStart = starts[starts.length - 1];
  const lastEnd = ends.length ? ends[ends.length - 1] : total;
  return (lastEnd >= total - 0.5 && total - lastStart > opt.tail) ? lastStart : null;
}

for (const f of files) {
  const total = dur(f);
  const speechEnd = detectSpeechEnd(f, total);
  const out = f.replace(/\.mp4$/i, ".trim.mp4");
  if (speechEnd == null) {
    execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", f, "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out]);
    console.log(`${f}: sin cola >${opt.tail}s (${total.toFixed(2)}s) — sin recorte`);
  } else {
    const cut = Math.min(total, speechEnd + opt.pad);
    execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", f, "-t", cut.toFixed(2), "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out]);
    console.log(`${f}: voz ~${speechEnd.toFixed(2)}s → ${total.toFixed(2)}s ⇒ ${cut.toFixed(2)}s  (-${(total - cut).toFixed(2)}s)`);
  }
}
