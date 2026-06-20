import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProductionSpec } from "../core/spec.js";
import type { BaseImage, SceneVideo } from "../core/types.js";
import type { Workspace } from "./workspace.js";

/**
 * Escribe un archivo independiente con los prompts usados para generar cada base_image,
 * junto a la ruta de su imagen — para revisar prompt vs. imagen creada.
 */
export function writeImagePromptsReport(workspace: Workspace, spec: ProductionSpec, images: BaseImage[]): string {
  const byId = new Map(images.map((i) => [i.baseImageId, i]));
  const lines: string[] = [
    `# Prompts de imagen — ${spec.video.client} · ${spec.video.course_category}`,
    "",
    `Aspect ratio: ${spec.video.aspect_ratio}. Un archivo por base_image (reutilizada en varias escenas).`,
    "",
    "Cada imagen se genera enviando al modelo DOS entradas: (1) el **prompt de texto** de abajo y",
    "(2) la **imagen de referencia del avatar** (adjunta como imagen, no como texto). El prompt NO",
    "describe la cara a propósito: la identidad/rostro viene de esa imagen de referencia.",
    "",
  ];

  for (const [id, base] of Object.entries(spec.base_images)) {
    const img = byId.get(id);
    lines.push(`## ${id} — ${base.character}${base.zone ? ` · ${base.zone}` : ""}`);
    if (base.framing) lines.push(`- **Encuadre:** ${base.framing}`);
    lines.push(`- **Usada en escenas:** ${base.used_in_scenes.join(", ") || "—"}`);
    lines.push(`- **Imagen de referencia (avatar, adjunta):** \`${img?.referenceImagePath ?? "(de config)"}\``);
    lines.push(`- **Imagen generada:** \`images/${id}.png\`${img ? "" : "  _(aún no generada)_"}`);
    if (img?.genSeconds != null) lines.push(`- **Tiempo de generación:** ${img.genSeconds}s`);
    lines.push("", "**Prompt de texto (lo que ves; la imagen de referencia va aparte):**", "", "```text", img?.prompt ?? "(no registrado)", "```", "");
  }

  const path = join(workspace.root, "image-prompts.md");
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

/**
 * Escribe el desglose de tiempos: por escena (imagen + video + subtotal) y el total.
 * El tiempo de imagen se atribuye a la PRIMERA escena que usa cada base_image; las
 * escenas que la reutilizan muestran 0 (reusa). Solo cuenta escenas renderizadas aquí.
 */
export function writeTimingsReport(
  workspace: Workspace,
  spec: ProductionSpec,
  images: BaseImage[],
  videos: SceneVideo[],
): { path: string; markdown: string } {
  const imgById = new Map(images.map((i) => [i.baseImageId, i]));
  const vidById = new Map(videos.map((v) => [v.sceneId, v]));
  const seenBase = new Set<string>();

  const rows: string[] = [];
  let totalImg = 0;
  let totalVid = 0;

  for (const scene of spec.scenes) {
    const v = vidById.get(scene.id);
    if (!v || v.genSeconds == null) continue; // solo escenas creadas en este run
    const baseId = scene.base_image;
    let imgT = 0;
    let note = `reusa ${baseId}`;
    if (!seenBase.has(baseId)) {
      seenBase.add(baseId);
      imgT = imgById.get(baseId)?.genSeconds ?? 0;
      note = baseId;
    }
    const vidT = v.genSeconds;
    totalImg += imgT;
    totalVid += vidT;
    rows.push(
      `| ${scene.id} | ${note} | ${imgT ? imgT.toFixed(1) : "—"} | ${vidT.toFixed(1)} | ${(imgT + vidT).toFixed(1)} |`,
    );
  }

  const total = totalImg + totalVid;
  const md = [
    `# Tiempos de creación — ${spec.video.client} · ${spec.video.course_category}`,
    "",
    "| Escena | Imagen base | Imagen (s) | Video (s) | Subtotal (s) |",
    "|---|---|---|---|---|",
    ...rows,
    `| **Total** | | **${totalImg.toFixed(1)}** | **${totalVid.toFixed(1)}** | **${total.toFixed(1)}** |`,
    "",
    `- Total imagen: ${totalImg.toFixed(1)}s · Total video: ${totalVid.toFixed(1)}s · **Total: ${total.toFixed(1)}s (${(total / 60).toFixed(1)} min)**`,
    "- El tiempo de imagen se cuenta una sola vez por base_image; las escenas que la reutilizan muestran un guion.",
    "- El tiempo de video incluye subida + render en HeyGen + descarga (espera real).",
    "",
  ].join("\n");

  const path = join(workspace.root, "timings.md");
  writeFileSync(path, md, "utf8");
  return { path, markdown: md };
}
