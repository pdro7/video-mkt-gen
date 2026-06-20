// Re-ejecuta SOLO la etapa de voice-changer (ElevenLabs STS) sobre los clips raw de Veo ya
// generados, con un `stability` distinto (sin re-renderizar en fal). Replica trim+mux del pipeline.
// Uso: node scripts/revoice-stability.mjs <runId> <stability> <suffix>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("Falta ELEVENLABS_API_KEY");
const [, , runId, stabilityArg, suffix = "stab"] = process.argv;
if (!runId || !stabilityArg) throw new Error("Uso: node scripts/revoice-stability.mjs <runId> <stability> <suffix>");
const stability = parseFloat(stabilityArg);

const cfg = JSON.parse(readFileSync("config.json", "utf8"));
const stsModel = cfg.video?.dynamic?.stsModel || "eleven_multilingual_sts_v2";
const charById = {}; for (const c of cfg.characters) charById[c.id] = c;
const R = `output/${runId}`;
const V = `${R}/videos`;
const man = JSON.parse(readFileSync(`${R}/manifest.json`, "utf8"));

const dur = (f) => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" }).trim()) || 0;

function detectSpeechEnd(audio, total) {
  let err = "";
  try { execFileSync("ffmpeg", ["-nostdin", "-i", audio, "-af", "silencedetect=noise=-30dB:d=0.4", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) { err = e.stderr?.toString() ?? ""; }
  const starts = [], ends = [];
  for (const m of err.matchAll(/silence_(start|end):\s*([\d.]+)/g)) (m[1] === "start" ? starts : ends).push(parseFloat(m[2]));
  if (!starts.length) return null;
  const lastStart = starts[starts.length - 1];
  const lastEnd = ends.length ? ends[ends.length - 1] : total;
  return (lastEnd >= total - 0.5 && total - lastStart > 0.6) ? lastStart : null;
}

async function sts(audioBuf, voiceId, params) {
  const vs = { stability, similarity_boost: params.similarity_boost ?? 0.75, style: params.style ?? 0, use_speaker_boost: params.speaker_boost ?? true };
  const fd = new FormData();
  fd.append("model_id", stsModel);
  fd.append("voice_settings", JSON.stringify(vs));
  fd.append("remove_background_noise", "true");
  fd.append("audio", new Blob([audioBuf], { type: "audio/mpeg" }), "audio.mp3");
  const res = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    { method: "POST", headers: { "xi-api-key": KEY }, body: fd });
  if (!res.ok) throw new Error(`STS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

const out = [];
for (const s of man.spec.scenes) {
  const isDuo = s.cast && s.cast.length > 1;
  const nn = String(s.id).padStart(2, "0");
  if (!s.motion || isDuo) { out.push({ id: s.id, file: `${V}/scene-${nn}.mp4`, reused: true }); continue; }
  const raw = `${V}/scene-${nn}.veo-raw.mp4`;
  const ch = charById[man.spec.base_images[s.base_image].character];
  const voiceId = ch.elevenLabs?.voiceId;
  if (!voiceId) throw new Error(`Personaje ${ch.id} sin elevenLabs.voiceId`);
  const tmp = mkdtempSync(join(tmpdir(), "revoice-"));
  const gen = join(tmp, "gen.mp3"), voice = join(tmp, "voice.mp3");
  execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", raw, "-vn", "-c:a", "libmp3lame", "-q:a", "2", gen]);
  console.log(`E${s.id} (${ch.id}): STS stability=${stability}...`);
  const voiceBuf = await sts(readFileSync(gen), voiceId, ch.elevenLabs.params || {});
  writeFileSync(voice, voiceBuf);
  const total = dur(raw);
  const speechEnd = detectSpeechEnd(voice, total);
  const outFile = `${V}/scene-${nn}.${suffix}.mp4`;
  const args = ["-nostdin", "-y", "-v", "error", "-i", raw, "-i", voice, "-map", "0:v:0", "-map", "1:a:0"];
  if (speechEnd != null) {
    const cut = Math.min(total, speechEnd + 0.4).toFixed(2);
    args.push("-t", cut, "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", outFile);
    console.log(`   trim a ${cut}s (de ${total.toFixed(1)}s)`);
  } else {
    args.push("-c:v", "copy", "-c:a", "aac", "-shortest", outFile);
  }
  execFileSync("ffmpeg", args);
  out.push({ id: s.id, file: outFile, reused: false });
}
writeFileSync(`/tmp/revoice-${suffix}-clips.json`, JSON.stringify(out, null, 2));
console.log("\nClips listos:", out.map((o) => `${o.id}${o.reused ? "(reuse)" : ""}`).join(" "));
