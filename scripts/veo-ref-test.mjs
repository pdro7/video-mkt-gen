// Veo 3.1 reference-to-video (el método "@avatar"): imagen(es) de referencia de personaje
// + prompt de texto, SIN fotograma inicial. Mantiene la identidad desde la cara nítida.
// Uso: node scripts/veo-ref-test.mjs <imgReferencia> <salida.mp4> "<prompt>" [modelo]
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync } from "node:fs";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) { console.error("Falta GOOGLE_API_KEY"); process.exit(1); }

const [, , refPath, outPath, prompt, modelArg] = process.argv;
const MODEL = modelArg || "veo-3.1-generate-preview";

const ai = new GoogleGenAI({ apiKey });
const imageBytes = readFileSync(refPath).toString("base64");
const mimeType = refPath.endsWith(".png") ? "image/png" : "image/jpeg";

console.log(`Veo (${MODEL}) reference-to-video (referencia: ${refPath})...`);
let operation = await ai.models.generateVideos({
  model: MODEL,
  prompt,
  config: {
    aspectRatio: "16:9",
    numberOfVideos: 1,
    referenceImages: [{ image: { imageBytes, mimeType }, referenceType: "asset" }],
  },
});

console.log("Operación iniciada; esperando render...");
let tries = 0;
while (!operation.done) {
  await new Promise((r) => setTimeout(r, 10000));
  operation = await ai.operations.getVideosOperation({ operation });
  console.log(`  poll ${++tries} done=${operation.done}`);
  if (tries > 90) throw new Error("timeout esperando a Veo");
}
if (operation.error) { console.error("ERROR op:", JSON.stringify(operation.error)); process.exit(1); }

const video = operation.response?.generatedVideos?.[0]?.video;
console.log("video keys:", video ? Object.keys(video) : "(none)");
if (video?.videoBytes) {
  writeFileSync(outPath, Buffer.from(video.videoBytes, "base64"));
  console.log("Guardado (inline) ->", outPath);
} else if (video?.uri) {
  const url = video.uri.includes("key=") ? video.uri : video.uri + (video.uri.includes("?") ? "&" : "?") + "key=" + apiKey;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`descarga ${res.status}: ${await res.text()}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  console.log("Guardado (uri) ->", outPath);
} else {
  await ai.files.download({ file: video, downloadPath: outPath });
  console.log("Guardado (sdk) ->", outPath);
}
