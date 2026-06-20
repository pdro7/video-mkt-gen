// Prueba: escena de cierre (E9) con DOS avatares (Elena + Marcos) vía HeyGen Cinematic Avatar.
// Cada look habla con su voz nativa (sin STS). Prompt EXACTO aprobado por el cliente.
// No toca la escena 9 actual; guarda un clip de prueba aparte.
import { writeFileSync } from "node:fs";

const KEY = process.env.HEYGEN_API_KEY;
if (!KEY) throw new Error("Falta HEYGEN_API_KEY");
const API = "https://api.heygen.com";
const H = { "X-Api-Key": KEY, "Content-Type": "application/json" };

import { lookId } from "./_lookId.mjs";
const SOFIA_LOOK = lookId("sofia");
const MARCOS_LOOK = lookId("marcos");

const prompt =
  `Cinematic corporate promo shot, 16:9, set in a lively modern open-plan office with real coworkers working in the background, clearly visible with only a light natural depth of field (no heavy blur, NOT a plain blue backdrop). TWO presenters enter from opposite sides and meet in the center facing the camera: a 30-something woman, Sofía (tailored light grey single-button blazer over a white blouse, navy trousers, a delicate thin gold necklace, small gold stud earrings), walks in from the LEFT; a 30-something man, Marcos (structured charcoal grey wool blazer over a light blue tailored dress shirt, no tie, discreet silver watch), walks in from the RIGHT. They stop side by side in the center, facing and addressing the camera. First Sofía says, in Spanish (Spain accent): "¿Listo para liderar la transformación digital de tu negocio?" Then Marcos says, in Spanish (Spain accent): "Entra en Ciber Aula y reserva tu plaza hoy." Keep each person's mouth in sync with their own line while the other listens and reacts naturally. Confident, warm, professional tone. Smooth camera with a slight push-in. Do NOT render any on-screen text, captions, subtitles or graphics.`;

const body = {
  type: "cinematic_avatar",
  prompt,
  avatar_id: [SOFIA_LOOK, MARCOS_LOOK],
  aspect_ratio: "16:9",
  resolution: "720p",
  auto_duration: true,
};

console.log("Enviando Cinematic Avatar (Sofía + Marcos)...");
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
  if (++tries > 120) throw new Error("timeout");
}
if (status === "failed") throw new Error(`failed: ${JSON.stringify(data.error ?? data)}`);
const out = "output/run_2026-06-18_alldyn/videos/scene-09-duo-test2.mp4";
writeFileSync(out, Buffer.from(await (await fetch(data.video_url)).arrayBuffer()));
console.log("\nGuardado:", out);
