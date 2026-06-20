// Test pronunciación: fal Veo 3.1 fast en modo IMAGE-TO-VIDEO (como Flow), con frame inicial de
// Sofía + diálogo con "ChatGPT" literal. Clip crudo (voz genérica de Veo) para juzgar pronunciación.
import { readFileSync, writeFileSync } from "node:fs";

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) throw new Error("Falta FAL_KEY");
const MODEL = "fal-ai/veo3.1/fast/image-to-video";
const auth = { Authorization: `Key ${FAL_KEY}` };

const img = readFileSync("chatgpt-previews/sofia-startframe.png");
const imgUri = `data:image/png;base64,${img.toString("base64")}`;
const prompt =
  `The woman in the image speaks directly to the camera with a confident open-hand gesture, in Spanish (Spain accent): "¿Cuántas horas pierdes cada semana en tareas repetitivas? Con ChatGPT puedes recuperarlas." Mouth in sync with the speech, lively office background, light depth of field, cinematic corporate promo, smooth motion. Do not render any on-screen text.`;

console.log("Enviando image-to-video (Veo 3.1 fast)...");
let res = await fetch(`https://queue.fal.run/${MODEL}`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, image_url: imgUri, aspect_ratio: "16:9", resolution: "720p", generate_audio: true }),
});
if (!res.ok) throw new Error(`submit ${res.status}: ${await res.text()}`);
const sub = await res.json();
console.log("request_id:", sub.request_id);

let status = "IN_QUEUE", tries = 0;
while (status !== "COMPLETED") {
  await new Promise((r) => setTimeout(r, 10000));
  const s = await (await fetch(sub.status_url, { headers: auth })).json();
  status = s.status;
  console.log("  status:", status);
  if (status === "FAILED" || status === "ERROR") throw new Error(JSON.stringify(s));
  if (++tries > 90) throw new Error("timeout");
}
const result = await (await fetch(sub.response_url, { headers: auth })).json();
const url = result.video?.url;
if (!url) throw new Error(`sin video.url: ${JSON.stringify(result)}`);
writeFileSync("chatgpt-previews/fal-i2v-sofia.mp4", Buffer.from(await (await fetch(url)).arrayBuffer()));
console.log("Guardado: chatgpt-previews/fal-i2v-sofia.mp4");
