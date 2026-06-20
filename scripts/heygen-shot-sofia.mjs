// Prueba puntual: Sofía (look HeyGen) diciendo la 1ª línea de R-001 (versión ficha), vía HeyGen
// Cinematic Avatar. Prompt EXACTO revisado por el cliente (no se regenera). Descarga el clip.
import { writeFileSync } from "node:fs";

const KEY = process.env.HEYGEN_API_KEY;
if (!KEY) throw new Error("Falta HEYGEN_API_KEY");
const API = "https://api.heygen.com";
const H = { "X-Api-Key": KEY, "Content-Type": "application/json" };

import { lookId } from "./_lookId.mjs";
const SOFIA_LOOK = lookId("sofia");
const prompt =
  `A 36-year-old female in tailored light grey single-button blazer over a white blouse, navy trousers, a delicate thin gold necklace, small gold stud earrings takes a couple of confident steps toward the camera with an open inviting gesture, looking directly into the camera and speaking the whole time. Keep the face TO CAMERA (front-facing) while talking; if there is movement, the person walks TOWARD the camera or the camera moves in front of them (dolly/push-in/slow arc) — never a side/profile shot while speaking. Setting: open-plan workspace with rows of modern desks, large monitors and ergonomic chairs, and several real coworkers actively working in the background; the office is clearly visible with only a light, natural depth of field (no heavy blur), conveying a busy real company. She says, in Spanish (Spain accent): "¿Cuántas horas pierdes cada semana en tareas repetitivas? Con ChatGPT puedes recuperarlas." Mouth in sync with the speech at all times. Lively background with people when the setting includes them, light natural depth of field (no heavy blur). Cinematic corporate promo, realistic, 16:9, smooth professional camera motion. Do NOT render any on-screen text, captions, subtitles or graphics.`;

const body = {
  type: "cinematic_avatar",
  prompt,
  avatar_id: [SOFIA_LOOK],
  aspect_ratio: "16:9",
  resolution: "720p",
  auto_duration: true,
};

let res = await fetch(`${API}/v3/videos`, { method: "POST", headers: H, body: JSON.stringify(body) });
let txt = await res.text();
if (!res.ok) throw new Error(`create ${res.status}: ${txt}`);
const videoId = JSON.parse(txt)?.data?.video_id;
console.log("video_id:", videoId);
if (!videoId) throw new Error("sin video_id");

let status = "processing", tries = 0, data = {};
while (status !== "completed" && status !== "failed") {
  await new Promise((r) => setTimeout(r, 10000));
  const j = await (await fetch(`${API}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, { headers: { "X-Api-Key": KEY } })).json();
  data = j?.data ?? {};
  status = data.status ?? "processing";
  console.log("  status:", status);
  if (++tries > 90) throw new Error("timeout");
}
if (status === "failed") throw new Error(`failed: ${JSON.stringify(data.error ?? data)}`);
const buf = Buffer.from(await (await fetch(data.video_url)).arrayBuffer());
writeFileSync("chatgpt-previews/heygenshot-sofia-r001.mp4", buf);
console.log("\nGuardado: chatgpt-previews/heygenshot-sofia-r001.mp4");
