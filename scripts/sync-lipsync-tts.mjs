// Lip-sync con Sync usando TTS de ElevenLabs INTEGRADO en Sync: en vez de subir un audio, le pasamos
// el DIÁLOGO de la escena + la voz de ElevenLabs del personaje. Sync sintetiza la voz y sincroniza la boca.
// Uso: node scripts/sync-lipsync-tts.mjs <runId> <sceneNN> [model] [source raw|final]
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const KEY = process.env.SYNC_API_KEY;
if (!KEY) throw new Error("Falta SYNC_API_KEY (.env)");
const API = "https://api.sync.so";
const [, , runId, sceneArg, model = "lipsync-2", source = "raw"] = process.argv;
if (!runId || !sceneArg) throw new Error("Uso: node scripts/sync-lipsync-tts.mjs <runId> <sceneNN> [model] [raw|final]");
const nn = String(sceneArg).padStart(2, "0");
const V = `output/${runId}/videos`;

const cfg = JSON.parse(readFileSync("config.json", "utf8"));
const charById = {}; for (const c of cfg.characters) charById[c.id] = c;
const man = JSON.parse(readFileSync(`output/${runId}/manifest.json`, "utf8"));
const scene = man.spec.scenes.find((s) => String(s.id).padStart(2, "0") === nn);
if (!scene) throw new Error(`No existe la escena ${nn}`);
const ch = charById[man.spec.base_images[scene.base_image].character];
const voiceId = ch.elevenLabs?.voiceId;
if (!voiceId) throw new Error(`Personaje ${ch.id} sin elevenLabs.voiceId`);
const script = scene.dialogue;
const params = ch.elevenLabs.params || {};

const videoFile = source === "final" ? `${V}/scene-${nn}.mp4` : `${V}/scene-${nn}.veo-raw.mp4`;
console.log(`Escena ${nn} · ${ch.id} · voz ${voiceId}`);
console.log(`Diálogo: "${script}"`);
console.log(`Vídeo fuente: ${videoFile}`);

async function upload(path, contentType) {
  const bytes = readFileSync(path);
  const r = await fetch(`${API}/v2/assets/upload`, {
    method: "POST",
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: basename(path), size: bytes.length, contentType }),
  });
  if (!r.ok) throw new Error(`assets/upload ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const put = await fetch(j.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  if (!put.ok) throw new Error(`PUT upload ${put.status}: ${await put.text()}`);
  return j.url;
}

console.log("Subiendo vídeo...");
const videoUrl = await upload(videoFile, "video/mp4");

console.log(`Creando generación (model=${model}, TTS ElevenLabs)...`);
const body = {
  model,
  input: [
    { type: "video", url: videoUrl },
    { type: "text", provider: { name: "elevenlabs", voiceId, script, stability: params.stability ?? 0.5, similarityBoost: params.similarity_boost ?? 0.75 } },
  ],
};
const genRes = await fetch(`${API}/v2/generate`, {
  method: "POST",
  headers: { "x-api-key": KEY, "Content-Type": "application/json" },
  body: JSON.stringify(body),
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
if (status !== "COMPLETED") throw new Error(`Sync terminó en ${status}: ${JSON.stringify(data.error ?? data.errorCode ?? data)}`);

const out = `${V}/scene-${nn}.sync-tts.mp4`;
writeFileSync(out, Buffer.from(await (await fetch(data.outputUrl)).arrayBuffer()));
console.log(`\n✅ Guardado: ${out}  (dur: ${data.outputDuration ?? "?"}s)`);
if (data.synthesizedAudioUrl) console.log(`   synthesizedAudioUrl: ${data.synthesizedAudioUrl.slice(0, 80)}...`);
