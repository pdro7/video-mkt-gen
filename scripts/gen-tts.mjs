// Genera el AUDIO TTS de una escena (ElevenLabs) aplicando el diccionario de pronunciación y,
// opcionalmente, ":" -> "," (pausa más corta). Para el flujo "audio primero".
// Uso: node scripts/gen-tts.mjs <runId> <sceneNN> <speed> <stability> <outFile> [--commas]
import { readFileSync, writeFileSync } from "node:fs";

const ELEVEN = process.env.ELEVENLABS_API_KEY;
if (!ELEVEN) throw new Error("Falta ELEVENLABS_API_KEY");
const [, , runId, sceneArg, speedArg, stabArg, outFile, ...flags] = process.argv;
if (!runId || !sceneArg || !speedArg || !stabArg || !outFile) {
  throw new Error("Uso: node scripts/gen-tts.mjs <runId> <sceneNN> <speed> <stability> <outFile> [--commas]");
}
const commas = flags.includes("--commas");
const cfg = JSON.parse(readFileSync("config.json", "utf8"));
const dict = cfg.video?.dynamic?.ttsPronunciation || {};
const respell = (t) => {
  let o = t;
  for (const [f, v] of Object.entries(dict)) o = o.replace(new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), v);
  return o;
};
const m = JSON.parse(readFileSync(`output/${runId}/manifest.json`, "utf8"));
const s = m.spec.scenes.find((x) => String(x.id).padStart(2, "0") === String(sceneArg).padStart(2, "0"));
if (!s) throw new Error(`No existe la escena ${sceneArg}`);
const ch = cfg.characters.find((c) => c.id === m.spec.base_images[s.base_image].character);
let text = respell(s.dialogue);
if (commas) text = text.replace(/:/g, ",");

console.log(`E${s.id} · ${ch.id} · speed ${speedArg} · stab ${stabArg}${commas ? " · ':'→','" : ""}`);
const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ch.elevenLabs.voiceId}?output_format=mp3_44100_128`, {
  method: "POST",
  headers: { "xi-api-key": ELEVEN, "Content-Type": "application/json" },
  body: JSON.stringify({
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      stability: parseFloat(stabArg),
      similarity_boost: ch.elevenLabs.params.similarity_boost,
      style: ch.elevenLabs.params.style,
      use_speaker_boost: ch.elevenLabs.params.speaker_boost,
      speed: parseFloat(speedArg),
    },
  }),
});
if (!r.ok) throw new Error(`ElevenLabs TTS ${r.status}: ${await r.text()}`);
writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
console.log(`  -> ${outFile}`);
