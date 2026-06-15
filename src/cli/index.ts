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

// generate: pipeline completo (spec -> images -> voice -> videos) en una nueva corrida.
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
    // Carga/valida la entrada antes de crear la carpeta de corrida.
    const brief = cmdOpts.brief ? readBrief(cmdOpts.brief) : undefined;
    const spec = cmdOpts.spec ? readSpec(cmdOpts.spec) : undefined;

    const ws = new Workspace(opts.output, makeRunId(new Date()));
    log.info(`Nueva corrida: ${ws.runId}`);
    const pipeline = new Pipeline(providers, config, ws, buildOverrides(cmdOpts), zones);
    const limit: number | undefined = cmdOpts.limit;

    let manifest = spec ? pipeline.ingestSpec(spec) : await pipeline.spec(brief!);
    manifest = await pipeline.images(manifest, limit);
    manifest = await pipeline.voice(manifest, limit);
    if (!cmdOpts.skipVideos) {
      manifest = await pipeline.videos(manifest, limit);
    } else {
      log.info("--skip-videos activo: no se generaron videos.");
    }
    log.info(`Listo. Artefactos en ${ws.root}`);
  });

// spec: solo generar el ProductionSpec (crea una corrida nueva).
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
    log.info(`Spec en ${ws.specPath} (corrida ${ws.runId}).`);
  });

// Etapas que reanudan una corrida existente por --run.
for (const stage of ["images", "voice", "videos"] as const) {
  program
    .command(stage)
    .description(`Ejecuta la etapa '${stage}' de una corrida existente.`)
    .requiredOption("-r, --run <runId>", "id de la corrida")
    .option("--limit <n>", "procesa solo las primeras N escenas (para pruebas)", (v) => parseInt(v, 10))
    .option("--expressiveness <level>", "fuerza expressiveness (low|medium|high) — solo 'videos'")
    .option("--no-motion", "omite el motion_prompt — solo 'videos'")
    .action(async (cmdOpts) => {
      const opts = program.opts<CommonOpts>();
      const { config, providers, zones } = setup(opts);
      const ws = openWorkspace(opts.output, cmdOpts.run);
      const pipeline = new Pipeline(providers, config, ws, buildOverrides(cmdOpts), zones);
      await pipeline[stage](ws.loadManifest(), cmdOpts.limit);
      log.info(`Etapa '${stage}' completada (corrida ${cmdOpts.run}).`);
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
  .description("Lista las corridas disponibles.")
  .action(() => {
    const opts = program.opts<CommonOpts>();
    const runs = listRuns(opts.output);
    if (runs.length === 0) log.info("No hay corridas todavía.");
    else runs.forEach((r) => log.info(r));
  });

program.parseAsync(process.argv).catch((e: Error) => {
  log.error(e.message);
  process.exitCode = 1;
});
