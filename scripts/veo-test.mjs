// Prueba standalone de Veo 3.1 (image -> video con diálogo) usando GOOGLE_API_KEY.
// Uso: node scripts/veo-test.mjs <imagenInicial> <salida.mp4> "<prompt>"
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync } from "node:fs";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) { console.error("Falta GOOGLE_API_KEY"); process.exit(1); }

const [, , imagePath, outPath, ...promptParts] = process.argv;
const prompt = promptParts.join(" ");
const MODEL = "veo-3.1-fast-generate-preview";

const ai = new GoogleGenAI({ apiKey });
const imageBytes = readFileSync(imagePath).toString("base64");
const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

console.log(`Veo (${MODEL}) image->video...`);
let operation = await ai.models.generateVideos({
  model: MODEL,
  prompt,
  image: { imageBytes, mimeType },
  config: { aspectRatio: "16:9", numberOfVideos: 1 },
});

console.log("Operación iniciada; esperando render...");
let tries = 0;
while (!operation.done) {
  await new Promise((r) => setTimeout(r, 10000));
  operation = await ai.operations.getVideosOperation({ operation });
  console.log(`  poll ${++tries} done=${operation.done}`);
  if (tries > 90) throw new Error("timeout esperando a Veo");
}

if (operation.error) {
  console.error("ERROR de la operación:", JSON.stringify(operation.error));
  process.exit(1);
}

const gv = operation.response?.generatedVideos?.[0];
console.log("generatedVideos[0] keys:", gv ? Object.keys(gv) : "(none)");
const video = gv?.video;
console.log("video keys:", video ? Object.keys(video) : "(none)");

if (video?.videoBytes) {
  writeFileSync(outPath, Buffer.from(video.videoBytes, "base64"));
  console.log("Guardado (inline) ->", outPath);
} else if (video?.uri) {
  const url = video.uri.includes("key=")
    ? video.uri
    : video.uri + (video.uri.includes("?") ? "&" : "?") + "key=" + apiKey;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`descarga ${res.status}: ${await res.text()}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  console.log("Guardado (uri) ->", outPath);
} else {
  await ai.files.download({ file: video, downloadPath: outPath });
  console.log("Guardado (sdk) ->", outPath);
}
