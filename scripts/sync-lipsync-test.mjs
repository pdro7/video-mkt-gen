// Prueba de lip-sync con Sync (sync.so) — SIN aceleración. Toma el clip RAW de Veo (visual) y le
// re-sincroniza la boca a la VOZ CLONADA de esa escena (extraída del clip final). Valida la herramienta.
// Uso: node scripts/sync-lipsync-test.mjs <runId> <sceneNN> [model] [source raw|final]
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const KEY = process.env.SYNC_API_KEY;
if (!KEY) throw new Error("Falta SYNC_API_KEY en el entorno (.env)");
const API = "https://api.sync.so";
const [, , runId, sceneArg, model = "lipsync-2", source = "raw"] = process.argv;
if (!runId || !sceneArg) throw new Error("Uso: node scripts/sync-lipsync-test.mjs <runId> <sceneNN> [model] [raw|final]");
const nn = String(sceneArg).padStart(2, "0");
const V = `output/${runId}/videos`;

const videoFile = source === "final" ? `${V}/scene-${nn}.mp4` : `${V}/scene-${nn}.veo-raw.mp4`;
// La voz clonada (objetivo del lip-sync) = el audio del clip final de la escena.
const tmp = mkdtempSync(join(tmpdir(), "sync-"));
const audioFile = join(tmp, `voice-${nn}.mp3`);
execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", `${V}/scene-${nn}.mp4`, "-vn", "-c:a", "libmp3lame", "-q:a", "2", audioFile]);
console.log(`Fuente vídeo: ${videoFile}`);
console.log(`Audio objetivo (voz clonada): ${audioFile}`);

async function upload(path, contentType) {
  const bytes = readFileSync(path);
  // 1) pedir URL prefirmada
  const r = await fetch(`${API}/v2/assets/upload`, {
    method: "POST",
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: basename(path), size: bytes.length, contentType }),
  });
  if (!r.ok) throw new Error(`assets/upload ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const uploadUrl = j.uploadUrl ?? j.url ?? j.presignedUrl;
  const finalUrl = j.url ?? j.assetUrl ?? j.publicUrl ?? uploadUrl;
  // 2) PUT del archivo
  const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  if (!put.ok) throw new Error(`PUT upload ${put.status}: ${await put.text()}`);
  console.log(`  subido ${basename(path)} -> ${String(finalUrl).slice(0, 70)}...`);
  return finalUrl;
}

console.log("Subiendo inputs a Sync...");
const videoUrl = await upload(videoFile, "video/mp4");
const audioUrl = await upload(audioFile, "audio/mpeg");

console.log(`Creando generación (model=${model})...`);
const genRes = await fetch(`${API}/v2/generate`, {
  method: "POST",
  headers: { "x-api-key": KEY, "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    input: [
      { type: "video", url: videoUrl },
      { type: "audio", url: audioUrl },
    ],
    // sin opciones = sync_mode "bounce" por defecto; sin aceleración.
  }),
});
const genTxt = await genRes.text();
if (!genRes.ok) throw new Error(`generate ${genRes.status}: ${genTxt}`);
const job = JSON.parse(genTxt);
console.log("job id:", job.id, "| status:", job.status);

let status = job.status, data = job, tries = 0;
while (!["COMPLETED", "FAILED", "REJECTED"].includes(status)) {
  await new Promise((r) => setTimeout(r, 6000));
  const r = await fetch(`${API}/v2/generate/${job.id}`, { headers: { "x-api-key": KEY } });
  if (!r.ok) throw new Error(`status ${r.status}: ${await r.text()}`);
  data = await r.json();
  status = data.status;
  console.log("  status:", status);
  if (++tries > 100) throw new Error("timeout esperando a Sync");
}
if (status !== "COMPLETED") throw new Error(`Sync terminó en ${status}: ${JSON.stringify(data.error ?? data)}`);

const out = `${V}/scene-${nn}.sync-lipsync.mp4`;
const buf = Buffer.from(await (await fetch(data.outputUrl)).arrayBuffer());
writeFileSync(out, buf);
console.log(`\n✅ Guardado: ${out}  (duración Sync: ${data.outputDuration ?? "?"}s)`);
