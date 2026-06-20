// Comparativa: MISMO clip que heygenshot-sofia-r001 pero con fal (Veo 3.1 fast) + ElevenLabs STS.
// Mismo prompt, misma línea, misma referencia (Avatars/sofia.jpeg). Solo cambia el motor.
import { readFileSync } from "node:fs";
import { FalDynamicVideoProvider } from "../dist/providers/dynamic/FalDynamicVideoProvider.js";
import { elevenVoiceId } from "./_lookId.mjs";

const falKey = process.env.FAL_KEY;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
if (!falKey || !elevenLabsApiKey) throw new Error("Faltan FAL_KEY / ELEVENLABS_API_KEY");

// EXACTAMENTE el mismo prompt que se envió a HeyGen Shots (scripts/heygen-shot-sofia.mjs).
const prompt =
  `A 36-year-old female in tailored light grey single-button blazer over a white blouse, navy trousers, a delicate thin gold necklace, small gold stud earrings takes a couple of confident steps toward the camera with an open inviting gesture, looking directly into the camera and speaking the whole time. Keep the face TO CAMERA (front-facing) while talking; if there is movement, the person walks TOWARD the camera or the camera moves in front of them (dolly/push-in/slow arc) — never a side/profile shot while speaking. Setting: open-plan workspace with rows of modern desks, large monitors and ergonomic chairs, and several real coworkers actively working in the background; the office is clearly visible with only a light, natural depth of field (no heavy blur), conveying a busy real company. She says, in Spanish (Spain accent): "¿Cuántas horas pierdes cada semana en tareas repetitivas? Con Chat he pe te puedes recuperarlas." Mouth in sync with the speech at all times. Lively background with people when the setting includes them, light natural depth of field (no heavy blur). Cinematic corporate promo, realistic, 16:9, smooth professional camera motion. Do NOT render any on-screen text, captions, subtitles or graphics.`;

const provider = new FalDynamicVideoProvider({
  falKey,
  elevenLabsApiKey,
  falModel: "fal-ai/veo3.1/fast/reference-to-video",
  stsModel: "eleven_multilingual_sts_v2",
});

await provider.generate({
  referenceImage: readFileSync("Avatars/sofia.jpeg"),
  referenceMimeType: "image/jpeg",
  prompt,
  voiceId: elevenVoiceId("sofia"),
  voiceSettings: { stability: 0.33, similarity_boost: 0.75, style: 0, speaker_boost: true },
  aspectRatio: "16:9",
  outputPath: "chatgpt-previews/falshot-sofia-r001-he.mp4",
});
console.log("Guardado: chatgpt-previews/falshot-sofia-r001-he.mp4");
