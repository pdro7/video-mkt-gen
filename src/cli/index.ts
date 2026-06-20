#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { assertCredentialsForConfig, loadConfig, loadCredentials } from "../config/config.js";
import { loadZoneLibrary, type ZoneLibrary } from "../config/zones.js";
import type { AppConfig } from "../config/schema.js";
import { createProviders, type Providers } from "../providers/factory.js";
import { Pipeline, type RenderOverrides } from "../core/pipeline.js";
import { parseCourseBrief, type CourseBrief } from "../core/brief.js";
import { parseProductionSpec, type ProductionSpec } from "../core/spec.js";
import { Workspace, makeRunId, openWorkspace, listRuns } from "../storage/workspace.js";
import { writeCatalog } from "../storage/catalog.js";
import { computeRunCost, renderCostsMarkdown } from "../core/costs.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("cli");
const DEFAULT_OUTPUT = "output";

interface CommonOpts {
  config: string;
  output: string;
}

function setup(opts: CommonOpts): { config: AppConfig; providers: Providers; zones: ZoneLibrary } {
  const config = loadConfig(opts.config);
  const creds = loadCredentials();
  assertCredentialsForConfig(config, creds);
  const zones = loadZoneLibrary(config.zonesPath);
  return { config, providers: createProviders(config, creds), zones };
}

function readBrief(briefPath: string): CourseBrief {
  const abs = resolve(briefPath);
  try {
    return parseCourseBrief(JSON.parse(readFileSync(abs, "utf8")));
  } catch (e) {
    throw new Error(`No se pudo leer/validar el brief ${abs}: ${(e as Error).message}`);
  }
}

function readSpec(specPath: string): ProductionSpec {
  const abs = resolve(specPath);
  try {
    return parseProductionSpec(JSON.parse(readFileSync(abs, "utf8")));
  } catch (e) {
    throw new Error(`No se pudo leer/validar el spec ${abs}: ${(e as Error).message}`);
  }
}

/** Overrides de render (expressiveness / sin motion) desde flags del CLI. */
function buildOverrides(cmdOpts: { expressiveness?: string; motion?: boolean }): RenderOverrides {
  const o: RenderOverrides = {};
  if (cmdOpts.expressiveness) {
    if (!["low", "medium", "high"].includes(cmdOpts.expressiveness)) {
      throw new Error("--expressiveness debe ser low|medium|high");
    }
    o.expressiveness = cmdOpts.expressiveness as RenderOverrides["expressiveness"];
  }
  if (cmdOpts.motion === false) o.omitMotionPrompt = true;
  return o;
}

const program = new Command();
program
  .name("video-gen")
  .description("Genera videos promocionales con avatares a partir de un brief de curso.")
  .option("-c, --config <path>", "ruta a config.json", "config.json")
  .option("-o, --output <dir>", "directorio de salida", DEFAULT_OUTPUT);

// generate: pipeline completo (spec -> images -> voice -> videos) en un nuevo run.
program
  .command("generate")
  .description("Ejecuta el pipeline completo desde un brief (Claude) o un spec hecho a mano.")
  .option("-b, --brief <path>", "brief del curso; Claude genera el spec")
  .option("-s, --spec <path>", "ProductionSpec hecho a mano; se ingiere tal cual (sin Claude)")
  .option("--skip-videos", "genera spec, imágenes y voz pero no llama a HeyGen", false)
  .option("--limit <n>", "procesa solo las primeras N escenas (para pruebas)", (v) => parseInt(v, 10))
  .option("--expressiveness <level>", "fuerza expressiveness en todas las escenas (low|medium|high)")
  .option("--no-motion", "omite el motion_prompt en todas las escenas")
  .action(async (cmdOpts) => {
    const opts = program.opts<CommonOpts>();
    if (!cmdOpts.brief && !cmdOpts.spec) throw new Error("Indica --brief <path> o --spec <path>.");
    if (cmdOpts.brief && cmdOpts.spec) throw new Error("Usa --brief o --spec, no ambos.");

    const { config, providers, zones } = setup(opts);
    // Carga/valida la entrada antes de crear la carpeta de run.
    const brief = cmdOpts.brief ? readBrief(cmdOpts.brief) : undefined;
    const spec = cmdOpts.spec ? readSpec(cmdOpts.spec) : undefined;

    const ws = new Workspace(opts.output, makeRunId(new Date()));
    log.info(`Nuevo run: ${ws.runId}`);
    const pipeline = new Pipeline(providers, config, ws, buildOverrides(cmdOpts), zones);
    const limit: number | undefined = cmdOpts.limit;

    let manifest = spec ? pipeline.ingestSpec(spec) : await pipeline.spec(brief!);
    manifest = await pipeline.images(manifest, limit);
    manifest = await pipeline.voice(manifest, limit);
    if (!cmdOpts.skipVideos) {
      manifest = await pipeline.videos(manifest, limit);
      // Montaje final automático (no aborta el run si ffmpeg falla; se omite con --limit).
      if (limit == null) {
        try {
          const finalPath = await pipeline.assemble(manifest);
          if (finalPath) log.info(`Video final: ${finalPath}`);
        } catch (e) {
          log.error(`Montaje final falló (los clips por escena están en videos/): ${(e as Error).message}`);
        }
      }
    } else {
      log.info("--skip-videos activo: no se generaron videos.");
    }
    log.info(`Listo. Artefactos en ${ws.root}`);
  });

// assemble: une las escenas completadas de un run en el mp4 final.
program
  .command("assemble")
  .description("Une las escenas de un run en un solo mp4 (normaliza resolución/fps + concat).")
  .requiredOption("-r, --run <runId>", "id del run")
  .action(async (cmdOpts) => {
    const opts = program.opts<CommonOpts>();
    const { config, providers, zones } = setup(opts);
    const ws = openWorkspace(opts.output, cmdOpts.run);
    const pipeline = new Pipeline(providers, config, ws, {}, zones);
    const finalPath = await pipeline.assemble(ws.loadManifest());
    log.info(finalPath ? `Video final: ${finalPath}` : "No había escenas completadas para montar.");
  });

// costs: recalcula la estimación de coste de un run (costs.md + cachea en el manifest).
program
  .command("costs")
  .description("Recalcula la estimación de coste de generación de un run (escribe costs.md).")
  .requiredOption("-r, --run <runId>", "id del run")
  .action((cmdOpts) => {
    const opts = program.opts<CommonOpts>();
    const config = loadConfig(opts.config);
    const ws = openWorkspace(opts.output, cmdOpts.run);
    const manifest = ws.loadManifest();
    const est = computeRunCost(manifest, config);
    writeFileSync(resolve(ws.root, "costs.md"), renderCostsMarkdown(ws.runId, est), "utf8");
    manifest.costEstimate = est;
    ws.saveManifest(manifest);
    log.info(`Coste estimado (generación API) ${ws.runId}: $${est.total.toFixed(2)} -> ${resolve(ws.root, "costs.md")}`);
  });

// revise: cambia UNA escena de un run y re-renderiza solo esa + re-monta.
program
  .command("revise")
  .description("Cambia una escena de un run (diálogo/movimiento/zona/personaje…) y re-renderiza solo esa.")
  .requiredOption("-r, --run <runId>", "id del run")
  .requiredOption("-s, --scene <n>", "id de la escena", (v) => parseInt(v, 10))
  .option("--dialogue <text>", "nuevo diálogo")
  .option("--motion <text>", "nuevo movimiento (convierte la escena en dinámica)")
  .option("--expressiveness <level>", "low|medium|high (talking-head)")
  .option("--zone <zoneId>", "nueva zona del decorado (regenera la imagen)")
  .option("--character <id>", "nuevo personaje (regenera la imagen)")
  .option("--make-talking-head", "convierte una escena dinámica en talking-head")
  .option("--regen-image", "regenera la imagen base (talking-head) sin cambiar zona/personaje")
  .option("--reroll", "re-tira la escena sin cambios (otra toma; útil para glitches de Veo)")
  .action(async (cmdOpts) => {
    const opts = program.opts<CommonOpts>();
    const { config, providers, zones } = setup(opts);
    const ws = openWorkspace(opts.output, cmdOpts.run);
    const pipeline = new Pipeline(providers, config, ws, {}, zones);
    const finalPath = await pipeline.revise(ws.loadManifest(), {
      sceneId: cmdOpts.scene,
      dialogue: cmdOpts.dialogue,
      motion: cmdOpts.motion,
      expressiveness: cmdOpts.expressiveness,
      zone: cmdOpts.zone,
      character: cmdOpts.character,
      makeTalkingHead: cmdOpts.makeTalkingHead,
      regenImage: cmdOpts.regenImage,
      reroll: cmdOpts.reroll,
    });
    log.info(
      finalPath
        ? `Escena ${cmdOpts.scene} revisada. Video final: ${finalPath}`
        : `Escena ${cmdOpts.scene} revisada (sin montaje).`,
    );
  });

// spec: solo generar el ProductionSpec (crea un run nuevo).
program
  .command("spec")
  .description("Genera solo el ProductionSpec (Claude).")
  .requiredOption("-b, --brief <path>", "archivo JSON con el brief del curso")
  .action(async (cmdOpts) => {
    const opts = program.opts<CommonOpts>();
    const { config, providers, zones } = setup(opts);
    const brief = readBrief(cmdOpts.brief);
    const ws = new Workspace(opts.output, makeRunId(new Date()));
    const pipeline = new Pipeline(providers, config, ws, {}, zones);
    await pipeline.spec(brief);
    log.info(`Spec en ${ws.specPath} (run ${ws.runId}).`);
  });

// Etapas que reanudan un run existente por --run.
for (const stage of ["images", "voice", "videos"] as const) {
  program
    .command(stage)
    .description(`Ejecuta la etapa '${stage}' de un run existente.`)
    .requiredOption("-r, --run <runId>", "id del run")
    .option("--limit <n>", "procesa solo las primeras N escenas (para pruebas)", (v) => parseInt(v, 10))
    .option("--expressiveness <level>", "fuerza expressiveness (low|medium|high) — solo 'videos'")
    .option("--no-motion", "omite el motion_prompt — solo 'videos'")
    .action(async (cmdOpts) => {
      const opts = program.opts<CommonOpts>();
      const { config, providers, zones } = setup(opts);
      const ws = openWorkspace(opts.output, cmdOpts.run);
      const pipeline = new Pipeline(providers, config, ws, buildOverrides(cmdOpts), zones);
      await pipeline[stage](ws.loadManifest(), cmdOpts.limit);
      log.info(`Etapa '${stage}' completada (run ${cmdOpts.run}).`);
    });
}

// convert: normaliza un spec (legacy o v2) al formato v2 canónico y lo escribe a un archivo.
program
  .command("convert")
  .description("Convierte un spec (legacy/v1 o v2) al formato v2 canónico.")
  .requiredOption("-s, --spec <path>", "spec de entrada (legacy o v2)")
  .requiredOption("--out <path>", "ruta del archivo v2 de salida")
  .action((cmdOpts) => {
    const spec = readSpec(cmdOpts.spec); // readSpec normaliza vía parseProductionSpec
    const out = resolve(cmdOpts.out);
    writeFileSync(out, JSON.stringify(spec, null, 2), "utf8");
    log.info(`Spec v2 escrito en ${out} (${spec.scenes.length} escenas).`);
  });

program
  .command("runs")
  .description("Lista los runs disponibles.")
  .action(() => {
    const opts = program.opts<CommonOpts>();
    const runs = listRuns(opts.output);
    if (runs.length === 0) log.info("No hay runs todavía.");
    else runs.forEach((r) => log.info(r));
  });

// catalog: genera un catálogo HTML de los cursos producidos (escanea output/).
program
  .command("catalog")
  .description("Genera un catálogo HTML de los cursos con vídeo (escanea output/).")
  .option("--out <path>", "ruta del HTML (default <output>/catalogo.html)")
  .action((cmdOpts) => {
    const opts = program.opts<CommonOpts>();
    const { path, courses, runs } = writeCatalog(opts.output, cmdOpts.out);
    log.info(`Catálogo: ${courses} cursos · ${runs} runs -> ${path}`);
  });

program.parseAsync(process.argv).catch((e: Error) => {
  log.error(e.message);
  process.exitCode = 1;
});
