import { createLogger } from "./logger.js";

const log = createLogger("retry");

/** Errores transitorios (red / 5xx / sobrecarga) que SÍ vale la pena reintentar.
 *  NO incluye cuota/créditos (RESOURCE_EXHAUSTED) ni 4xx: esos no se resuelven reintentando. */
const TRANSIENT =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|timed? ?out|\b50[0234]\b|overloaded|temporarily/i;

/** Reintenta `fn` ante errores transitorios, con backoff. Relanza tras agotar intentos. */
export async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = (e as Error)?.message ?? String(e);
      if (attempt === retries || !TRANSIENT.test(msg)) throw e;
      const wait = Math.min(2000 * attempt, 8000);
      log.warn(`${label}: intento ${attempt}/${retries} falló (${msg.slice(0, 90)}); reintento en ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
