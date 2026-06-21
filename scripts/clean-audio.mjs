// Mejora y limpieza del audio de un vídeo final (sin tocar el vídeo):
//  - highpass 70 Hz: quita retumbe/graves de sala
//  - loudnorm (EBU R128, -16 LUFS): normaliza el volumen a estándar de streaming
//  - presencia (+2 dB a 3.5 kHz): voz más clara/presente
// Copia el stream de vídeo tal cual; solo re-encoda el audio.
// Uso: node scripts/clean-audio.mjs <input.mp4> [output.mp4]
import { execFileSync } from "node:child_process";

const [, , input, outArg] = process.argv;
if (!input) throw new Error("Uso: node scripts/clean-audio.mjs <input.mp4> [output.mp4]");
const out = outArg || input.replace(/\.mp4$/i, "-cleanaudio.mp4");

const af = "highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=11,equalizer=f=3500:t=q:w=1.2:g=2";
execFileSync("ffmpeg", [
  "-nostdin", "-y", "-v", "error", "-i", input,
  "-c:v", "copy",
  "-af", af,
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
  out,
], { stdio: "inherit" });
console.log(`✅ Audio mejorado -> ${out}`);
