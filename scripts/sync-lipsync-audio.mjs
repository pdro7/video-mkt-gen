// Lip-sync con Sync usando un AUDIO ya generado (no TTS). Sube el visual de Veo + el audio dado y
// re-sincroniza la boca. Útil cuando ya tenemos el audio bueno (p. ej. con respelling verificado).
// Uso: node scripts/sync-lipsync-audio.mjs <runId> <sceneNN> <audioFile> [model] [raw|final] [outFile]
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const KEY = process.env.SYNC_API_KEY;
if (!KEY) throw new Error("Falta SYNC_API_KEY (.env)");
const API = "https://api.sync.so";
const [, , runId, sceneArg, audioFile, model = "sync-3", source = "raw", outArg] = process.argv;
if (!runId || !sceneArg || !audioFile) throw new Error("Uso: node scripts/sync-lipsync-audio.mjs <runId> <sceneNN> <audioFile> [model] [raw|final] [outFile]");
const nn = String(sceneArg).padStart(2, "0");
const V = `output/${runId}/videos`;
const videoFile = source === "final" ? `${V}/scene-${nn}.mp4` : `${V}/scene-${nn}.veo-raw.mp4`;
const out = outArg || `${V}/scene-${nn}.synclipsync.mp4`;

async function upload(path, contentType) {
  const bytes = readFileSync(path);
  const r = await fetch(`${API}/v2/assets/upload`, {
    method: "POST", headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: basename(path), size: bytes.length, contentType }),
  });
  if (!r.ok) throw new Error(`assets/upload ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const put = await fetch(j.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  if (!put.ok) throw new Error(`PUT ${put.status}: ${await put.text()}`);
  return j.url;
}

console.log(`Escena ${nn} · vídeo ${basename(videoFile)} · audio ${basename(audioFile)} · model ${model}`);
const videoUrl = await upload(videoFile, "video/mp4");
const audioUrl = await upload(audioFile, "audio/mpeg");
const genRes = await fetch(`${API}/v2/generate`, {
  method: "POST", headers: { "x-api-key": KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ model, input: [{ type: "video", url: videoUrl }, { type: "audio", url: audioUrl }] }),
});
const genTxt = await genRes.text();
if (!genRes.ok) throw new Error(`generate ${genRes.status}: ${genTxt}`);
const job = JSON.parse(genTxt);
console.log("job id:", job.id, "| status:", job.status);

let status = job.status, data = job, tries = 0;
while (!["COMPLETED", "FAILED", "REJECTED"].includes(status)) {
  await new Promise((r) => setTimeout(r, 6000));
  const r = await fetch(`${API}/v2/generate/${job.id}`, { headers: { "x-api-key": KEY } });
  data = await r.json();
  status = data.status;
  console.log("  status:", status);
  if (++tries > 100) throw new Error("timeout");
}
if (status !== "COMPLETED" || !data.outputUrl) throw new Error(`Sync ${status}: ${JSON.stringify(data.error ?? data.errorCode ?? "")}`);
writeFileSync(out, Buffer.from(await (await fetch(data.outputUrl)).arrayBuffer()));
console.log(`✅ Guardado: ${out}  (dur: ${data.outputDuration ?? "?"}s)`);
