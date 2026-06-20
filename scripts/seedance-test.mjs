// Prueba Seedance 2.0 reference-to-video con voz real (ElevenLabs TTS) por audio_urls.
// Lip-sync nativo a NUESTRO audio -> sin voice-changer (STS). Escena 1 (Sofía) del run veofast.
import { readFileSync, writeFileSync } from "node:fs";

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) throw new Error("Falta FAL_KEY");

const RUN = "output/run_2026-06-17_11-32-54_veofast";
const MODEL = "bytedance/seedance-2.0/fast/reference-to-video"; // standard (1080p disponible)

const config = JSON.parse(readFileSync("config.json", "utf8"));
const zones = JSON.parse(readFileSync("zones.json", "utf8"));
const manifest = JSON.parse(readFileSync(`${RUN}/manifest.json`, "utf8"));
const scene = manifest.spec.scenes.find((s) => s.id === 1);
const base = manifest.spec.base_images[scene.base_image];
const sofia = config.characters.find((c) => c.id === "sofia");
const zoneDesc = zones[base.zone];

const img = readFileSync(sofia.referenceImagePath);
const imgUri = `data:image/jpeg;base64,${img.toString("base64")}`;
const audio = readFileSync(`${RUN}/audio/scene-01.mp3`);
const audioUri = `data:audio/mpeg;base64,${audio.toString("base64")}`;

const prompt = [
  `The woman from the reference image ${scene.motion}, speaking directly to the camera.`,
  `Her lips are synced to the provided audio track.`,
  `Keep her exact face, hair and appearance (${sofia.wardrobe}).`,
  `Setting: ${zoneDesc}.`,
  `Cinematic corporate promo, realistic, 16:9, smooth natural motion.`,
  `Do NOT render any on-screen text, captions, subtitles or graphics.`,
].join(" ");

console.log("Prompt:", prompt, "\n");

const auth = { Authorization: `Key ${FAL_KEY}` };

console.log("Enviando a Seedance (1080p)...");
let res = await fetch(`https://queue.fal.run/${MODEL}`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt,
    image_urls: [imgUri],
    audio_urls: [audioUri],
    resolution: "720p",
    aspect_ratio: "16:9",
    duration: "auto",
    generate_audio: true,
  }),
});
if (!res.ok) throw new Error(`submit ${res.status}: ${await res.text()}`);
const sub = await res.json();
console.log("request_id:", sub.request_id);

let status = "IN_QUEUE";
let tries = 0;
while (status !== "COMPLETED") {
  await new Promise((r) => setTimeout(r, 10000));
  const s = await (await fetch(sub.status_url, { headers: auth })).json();
  status = s.status;
  console.log("  status:", status);
  if (status === "FAILED" || status === "ERROR") throw new Error(`Seedance falló: ${JSON.stringify(s)}`);
  if (++tries > 120) throw new Error("timeout");
}
const result = await (await fetch(sub.response_url, { headers: auth })).json();
console.log("result:", JSON.stringify(result).slice(0, 400));
const url = result.video?.url || result.data?.video?.url;
if (!url) throw new Error(`sin video.url: ${JSON.stringify(result)}`);
const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync("chatgpt-previews/seedance-sofia-scene1-genaudio.mp4", buf);
console.log("\nGuardado: chatgpt-previews/seedance-sofia-scene1-genaudio.mp4");
