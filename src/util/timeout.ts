/**
 * Carrera de una promesa contra un timeout. Si vence, rechaza con un error cuyo mensaje incluye
 * "timed out" (lo reconoce withRetry como transitorio -> reintenta). Nota: no cancela la llamada
 * subyacente si el SDK no soporta AbortSignal; solo deja de esperarla para poder reintentar.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
