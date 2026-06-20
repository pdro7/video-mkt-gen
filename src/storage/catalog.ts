import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { listRuns } from "./workspace.js";
import { writeSceneSheet } from "./sceneSheet.js";
import type { RunManifest } from "../core/types.js";

interface ScriptLine {
  id: number;
  tag: "D" | "TH" | "DÚO";
  char: string;
  line: string;
  /** Si la escena tiene varios hablantes (p. ej. dúo HeyGen), la línea de cada uno. */
  parts?: { char: string; line: string }[];
}

interface CourseRow {
  course: string;
  url?: string;
  runId: string;
  createdAt: string;
  /** createdAt del PRIMER run de este curso (para asignar el ID estable). */
  firstSeen: string;
  /** ID corto estable por curso (R-001, R-002…). */
  id?: string;
  scenes: number;
  dynamic: number;
  completed: number;
  finalVideoRel?: string;
  status: "video" | "partial" | "spec" | "empty";
  runsForCourse: number;
  script: ScriptLine[];
  /** Coste de generación (API) estimado, si el manifest lo tiene cacheado. */
  costTotal?: number;
  /** Ruta relativa a la hoja de escenas (miniaturas), si el run tiene vídeo. */
  sceneSheetRel?: string;
}

const esc = (s: string): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Escanea output/, lee los manifests y escribe un catálogo HTML de los cursos producidos (con guion). */
export function writeCatalog(outputDir: string, outPath?: string): { path: string; courses: number; runs: number } {
  const abs = resolve(outputDir);
  const rows: CourseRow[] = [];

  for (const runId of listRuns(abs)) {
    const mPath = join(abs, runId, "manifest.json");
    if (!existsSync(mPath)) continue;
    let m: RunManifest;
    try {
      m = JSON.parse(readFileSync(mPath, "utf8")) as RunManifest;
    } catch {
      continue;
    }
    const scenes = m.spec?.scenes ?? [];
    const dynamic = scenes.filter((s) => s.motion).length;
    const completed = (m.videos ?? []).filter((v) => v.status === "completed").length;
    const finalVideo = m.finalVideo && existsSync(m.finalVideo) ? `${runId}/${basename(m.finalVideo)}` : undefined;
    const status: CourseRow["status"] = finalVideo ? "video" : completed > 0 ? "partial" : scenes.length > 0 ? "spec" : "empty";
    // Hoja de escenas (miniaturas) para runs con vídeo; miniaturas cacheadas.
    let sceneSheetRel: string | undefined;
    if (finalVideo) {
      try {
        sceneSheetRel = writeSceneSheet(join(abs, runId), m) ?? undefined;
      } catch {
        sceneSheetRel = undefined;
      }
    }
    const script: ScriptLine[] = scenes.map((s) => {
      const cast = s.cast;
      if (cast && cast.length > 1) {
        return {
          id: s.id,
          tag: "DÚO" as const,
          char: cast.map((c) => c.character).join(" + "),
          line: "",
          parts: cast.map((c) => ({ char: c.character, line: c.dialogue })),
        };
      }
      return {
        id: s.id,
        tag: s.motion ? ("D" as const) : ("TH" as const),
        char: m.spec?.base_images?.[s.base_image]?.character ?? "",
        line: s.dialogue ?? "",
      };
    });
    rows.push({
      course: m.brief?.course_category ?? runId,
      url: m.brief?.source_url ?? m.brief?.course_url,
      runId,
      createdAt: m.createdAt ?? "",
      firstSeen: m.createdAt ?? "",
      scenes: scenes.length,
      dynamic,
      completed,
      finalVideoRel: finalVideo,
      status,
      runsForCourse: 1,
      script,
      costTotal: m.costEstimate?.total,
      sceneSheetRel,
    });
  }

  // Una entrada por CURSO: el run más reciente (clave = url || nombre); firstSeen = el más antiguo.
  const byCourse = new Map<string, CourseRow>();
  for (const r of rows) {
    const key = r.course || r.url || r.runId; // el nombre del curso es estable entre runs (con o sin url)
    const prev = byCourse.get(key);
    if (!prev) byCourse.set(key, { ...r });
    else {
      const runs = prev.runsForCourse + 1;
      const firstSeen = prev.firstSeen < r.firstSeen ? prev.firstSeen : r.firstSeen;
      const latest = r.createdAt > prev.createdAt ? r : prev;
      byCourse.set(key, { ...latest, runsForCourse: runs, firstSeen });
    }
  }
  const courses = [...byCourse.values()];
  // ID corto ESTABLE: por orden de primera aparición del curso (no cambia al regenerar).
  [...courses]
    .sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1))
    .forEach((c, i) => (c.id = `R-${String(i + 1).padStart(3, "0")}`));
  // Mostrar por más reciente primero.
  courses.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const withVideo = courses.filter((c) => c.status === "video").length;

  const html = renderHtml(courses, { courses: courses.length, withVideo, runs: rows.length });
  const target = outPath ? resolve(outPath) : join(abs, "catalogo.html");
  writeFileSync(target, html, "utf8");
  return { path: target, courses: courses.length, runs: rows.length };
}

const BADGE: Record<CourseRow["status"], string> = {
  video: '<span class="b ok">✅ Vídeo listo</span>',
  partial: '<span class="b mid">🟡 Parcial</span>',
  spec: '<span class="b sp">📝 Solo guion</span>',
  empty: '<span class="b no">— vacío</span>',
};

function renderCard(r: CourseRow): string {
  const fecha = r.createdAt ? r.createdAt.slice(0, 16).replace("T", " ") : "";
  const url = r.url ? `<a href="${esc(r.url)}" target="_blank">ficha ↗</a>` : "";
  const video = r.finalVideoRel ? `<a href="${esc(r.finalVideoRel)}">▶ ver vídeo</a>` : "";
  const sheet = r.sceneSheetRel ? `<a href="${esc(r.sceneSheetRel)}">🎬 escenas</a>` : "";
  const runsTag = r.runsForCourse > 1 ? `<span class="muted">· ${r.runsForCourse} runs</span>` : "";
  const cost = r.costTotal != null ? `<span class="cost" title="Coste estimado de generación API (clips finales, sin iteraciones)">💰 ~$${r.costTotal.toFixed(2)}</span>` : "";
  const meta = [video, sheet, url, r.scenes ? `${r.scenes} esc · ${r.dynamic} din` : "", cost, fecha, `<span class="muted">${esc(r.runId)}</span>`]
    .filter(Boolean)
    .join(" &nbsp;·&nbsp; ");
  const script = r.script.length
    ? `<details><summary>📝 Ver guion (${r.script.length} escenas)</summary><ol class="script">${r.script
        .map((l) => {
          const cls = l.tag === "D" ? "d" : l.tag === "DÚO" ? "duo" : "th";
          const body = l.parts
            ? l.parts.map((p) => `<div class="part"><b>${esc(p.char)}:</b> ${esc(p.line)}</div>`).join("")
            : `<b>${esc(l.char)}</b> — ${esc(l.line)}`;
          return `<li><span class="tag ${cls}">${esc(l.tag)}</span> ${body}</li>`;
        })
        .join("")}</ol></details>`
    : "";
  const id = r.id ? `<span class="cid">${esc(r.id)}</span> ` : "";
  return `<div class="course"><div class="chead">${id}<span class="ctitle">${esc(r.course)}</span> ${BADGE[r.status]} ${runsTag}</div><div class="cmeta">${meta}</div>${script}</div>`;
}

function renderHtml(rows: CourseRow[], n: { courses: number; withVideo: number; runs: number }): string {
  const body = rows.length ? rows.map(renderCard).join("\n") : '<p class="muted">Sin runs todavía.</p>';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catálogo de vídeos — Ciberaula</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--line:#e3e6ea;--ink:#1c2430;--muted:#6b7480}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:32px 20px}
h1{margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.cards{display:flex;gap:12px;margin:0 0 22px;flex-wrap:wrap}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 18px}.card b{font-size:22px;display:block}
.course{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin-bottom:12px}
.chead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cid{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:#2a52a8;background:#e7eefc;border:1px solid #c7d6f5;border-radius:6px;padding:2px 7px}
.ctitle{font-size:17px;font-weight:600}
.cmeta{color:var(--muted);font-size:13.5px;margin:6px 0 2px}
.cmeta a{color:#2a52a8;text-decoration:none}.cmeta a:hover{text-decoration:underline}
details{margin-top:10px}summary{cursor:pointer;color:#2a52a8;font-size:14px}
ol.script{margin:10px 0 4px;padding-left:6px;list-style:none}
ol.script li{padding:5px 0;border-bottom:1px solid #f0f2f4}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:5px;margin-right:6px}
.tag.d{background:#f3d9ff;color:#7a2aa8}.tag.th{background:#e6eaef;color:#566}.tag.duo{background:#ffe7cc;color:#a85a1a}
ol.script .part{padding:1px 0}ol.script .part b{color:#1c2430}
.muted{color:var(--muted)}
.cost{color:#1c7a3a;font-weight:600}
.b{font-size:13px;padding:2px 9px;border-radius:20px;white-space:nowrap}
.b.ok{background:#e3f6e8;color:#1c7a3a}.b.mid{background:#fdf3d7;color:#8a6d10}.b.sp{background:#e7eefc;color:#2a52a8}.b.no{background:#eee;color:#888}
.foot{color:var(--muted);font-size:12px;margin-top:18px}
</style></head><body><div class="wrap">
<h1>Catálogo de vídeos</h1>
<p class="sub">Cursos producidos · regenera con <code>catalog</code> · escanea <code>output/</code></p>
<div class="cards">
  <div class="card"><b>${n.courses}</b>cursos</div>
  <div class="card"><b>${n.withVideo}</b>con vídeo listo</div>
  <div class="card"><b>${n.runs}</b>runs totales</div>
</div>
${body}
<p class="foot">Una tarjeta por curso (run más reciente). "D" = dinámica, "TH" = talking-head, "DÚO" = varios avatares en una toma. Enlaces de vídeo relativos a output/.</p>
</div></body></html>`;
}
