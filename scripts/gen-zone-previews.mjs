// Genera una foto de entorno por cada zona de zones.json (catálogo visual) Y sincroniza la
// galería de la guía (docs/guia.html) entre los marcadores <!-- ZONES:START/END -->.
//   node scripts/gen-zone-previews.mjs           -> regenera imágenes + sincroniza guía
//   node scripts/gen-zone-previews.mjs --sync     -> solo sincroniza la guía (no genera imágenes)
//   node scripts/gen-zone-previews.mjs ZONE_9 ...  -> regenera solo esas zonas + sincroniza
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const syncOnly = args.includes("--sync");
const only = args.filter((a) => a.startsWith("ZONE_"));
const zones = JSON.parse(readFileSync("zones.json", "utf8"));

if (!syncOnly) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("Falta GOOGLE_API_KEY");
  mkdirSync("zone-previews", { recursive: true });
  const { NanoBananaProvider } = await import("../dist/providers/image/NanoBananaProvider.js");
  const provider = new NanoBananaProvider({ apiKey: key, model: "gemini-2.5-flash-image" });
  const ids = only.length ? only : Object.keys(zones);
  for (const id of ids) {
    const desc = zones[id];
    if (!desc) { console.log(`${id} ✗ (no existe en zones.json)`); continue; }
    const prompt = `Professional corporate interior/environment photograph: ${desc}. Include the people/activity mentioned to feel like a lively real company. LIGHT, natural depth of field — the environment stays clearly visible and recognizable, NO heavy lens blur or bokeh. Realistic, cinematic natural lighting, modern, horizontal 16:9 composition, high quality. No text, no logos, no on-screen graphics.`;
    try {
      const img = await provider.generateScene({ prompt, referenceImages: [], aspectRatio: "16:9" });
      writeFileSync(`zone-previews/${id}.png`, img.data);
      console.log(`${id} ✓`);
    } catch (e) {
      console.log(`${id} ✗ ${e.message}`);
    }
  }
}

// Sincronizar la galería de la guía desde zones.json (imagen + descripción siempre coherentes).
syncGuide(zones);
console.log("done");

function syncGuide(zones) {
  const path = "docs/guia.html";
  let html;
  try {
    html = readFileSync(path, "utf8");
  } catch {
    console.log("(guía no encontrada; se omite sincronización)");
    return;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const cards = Object.entries(zones)
    .map(([k, v]) => `    <figure class="zone"><img src="../zone-previews/${k}.png" alt="${k}" loading="lazy"><figcaption><b>${k}</b> — ${esc(v)}</figcaption></figure>`)
    .join("\n");
  const grid = `  <div class="zone-grid">\n${cards}\n  </div>`;
  const re = /(<!-- ZONES:START[^>]*-->\n)[\s\S]*?(\n  <!-- ZONES:END -->)/;
  if (!re.test(html)) {
    console.log("(marcadores ZONES no encontrados en la guía; se omite)");
    return;
  }
  writeFileSync(path, html.replace(re, `$1${grid}$2`), "utf8");
  console.log(`guía sincronizada: ${Object.keys(zones).length} zonas`);
}
