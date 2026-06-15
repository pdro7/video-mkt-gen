/** Logger mínimo con niveles y prefijo de etapa. Sin dependencias externas. */

type Level = "info" | "warn" | "error" | "debug";

const DEBUG = process.env.VIDEO_GEN_DEBUG === "1";

function emit(level: Level, scope: string, msg: string): void {
  if (level === "debug" && !DEBUG) return;
  const tag = `[${scope}]`;
  const line = `${tag} ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    info: (msg: string) => emit("info", scope, msg),
    warn: (msg: string) => emit("warn", scope, msg),
    error: (msg: string) => emit("error", scope, msg),
    debug: (msg: string) => emit("debug", scope, msg),
  };
}

export type Logger = ReturnType<typeof createLogger>;
