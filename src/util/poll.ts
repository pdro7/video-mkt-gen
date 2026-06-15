/** Utilidades de espera/reintento para jobs asíncronos (p. ej. render de HeyGen). */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface PollOptions {
  /** Intervalo entre intentos en ms. */
  intervalMs?: number;
  /** Tiempo máximo total de espera en ms. */
  timeoutMs?: number;
}

/**
 * Llama a `fn` repetidamente hasta que `done` devuelva true sobre su resultado,
 * o hasta agotar el timeout. Devuelve el último resultado.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  { intervalMs = 5000, timeoutMs = 10 * 60 * 1000 }: PollOptions = {},
): Promise<T> {
  const start = startTime();
  let last = await fn();
  while (!done(last)) {
    if (elapsed(start) > timeoutMs) {
      throw new Error(`pollUntil: timeout tras ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

// process.hrtime evita Date.now() y funciona sin reloj de pared.
function startTime(): bigint {
  return process.hrtime.bigint();
}
function elapsed(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}
