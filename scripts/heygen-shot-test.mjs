// Prueba HeyGen Cinematic Avatar (Avatar Shots / Seedance 2.0) por API.
// type:"cinematic_avatar", avatar_id = look registrado. Vemos si habla / hay lip-sync.
import { writeFileSync } from "node:fs";

const KEY = process.env.HEYGEN_API_KEY;
if (!KEY) throw new Error("Falta HEYGEN_API_KEY");
const API = "https://api.heygen.com";
const H = { "X-Api-Key": KEY, "Content-Type": "application/json" };

import { lookId } from "./_lookId.mjs";
const MARCOS_LOOK = lookId("marcos");
const dialogue = "Mejorarás la comunicación de tu negocio con respuestas rápidas, ideas creativas y mensajes claros para cada cliente, en mucho menos tiempo.";
const prompt = [
  "A 44-year-old man in a charcoal grey wool blazer over a light blue shirt walks TOWARD the camera at a relaxed, confident pace through a bright modern open-plan office, looking directly into the lens and speaking the whole time.",
  "The camera dollies smoothly BACKWARD, staying right in front of him at eye level, keeping his face centered and to camera (shallow depth of field, warm natural light, softly blurred coworkers behind).",
  "He reaches an ergonomic chair and sits down WITHOUT breaking eye contact with the camera, continuing to speak directly to the lens, with a subtle cinematic push-in as he settles.",
  `He says, in Spanish (Spain accent): "${dialogue}"`,
  "His mouth moves in sync with the speech at all times. Cinematic corporate promo, realistic, smooth professional camera motion. Do not render any on-screen text.",
].join(" ");

console.log("Prompt:", prompt, "\n");

const body = {
  type: "cinematic_avatar",
  prompt,
  avatar_id: [MARCOS_LOOK],
  aspect_ratio: "16:9",
  resolution: "720p",
  auto_duration: true,
};

let res = await fetch(`${API}/v3/videos`, { method: "POST", headers: H, body: JSON.stringify(body) });
let txt = await res.text();
if (!res.ok) throw new Error(`create ${res.status}: ${txt}`);
const created = JSON.parse(txt);
const videoId = created?.data?.video_id ?? created?.video_id ?? created?.data?.id;
console.log("video_id:", videoId, "| respuesta:", txt.slice(0, 200));
if (!videoId) throw new Error("sin video_id");

let status = "processing";
let tries = 0;
let data = {};
while (status !== "completed" && status !== "failed") {
  await new Promise((r) => setTimeout(r, 10000));
  const r = await fetch(`${API}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, { headers: { "X-Api-Key": KEY } });
  const j = await r.json();
  data = j?.data ?? {};
  status = data.status ?? "processing";
  console.log("  status:", status);
  if (++tries > 90) throw new Error("timeout");
}
if (status === "failed") throw new Error(`failed: ${JSON.stringify(data.error ?? data)}`);

const url = data.video_url;
console.log("video_url:", url);
const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync("chatgpt-previews/heygenshot-marcos-walk-sit-v2.mp4", buf);
console.log("\nGuardado: chatgpt-previews/heygenshot-marcos-walk-sit-v2.mp4");
