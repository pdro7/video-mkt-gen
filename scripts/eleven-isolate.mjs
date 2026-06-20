// Aísla la VOZ de un audio (quita música/fondo) con la API Audio Isolation de ElevenLabs.
// Uso: node scripts/eleven-isolate.mjs <input-audio> <output-audio>
import { readFileSync, writeFileSync } from "node:fs";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("Falta ELEVENLABS_API_KEY");
const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) throw new Error("Uso: node scripts/eleven-isolate.mjs <input> <output>");

const bytes = readFileSync(inPath);
const form = new FormData();
form.append("audio", new Blob([bytes], { type: "audio/wav" }), "input.wav");

console.log("Aislando voz (ElevenLabs Audio Isolation)...");
const res = await fetch("https://api.elevenlabs.io/v1/audio-isolation", {
  method: "POST",
  headers: { "xi-api-key": KEY },
  body: form,
});
if (!res.ok) throw new Error(`audio-isolation ${res.status}: ${await res.text()}`);
writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
console.log("Guardado:", outPath);
