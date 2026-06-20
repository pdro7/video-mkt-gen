import { createLogger } from "./logger.js";
import { withRetry } from "./retry.js";
import { withTimeout } from "./timeout.js";

const log = createLogger("course-page");

/**
 * Descarga la ficha (página web) de un curso y devuelve su TEXTO limpio, para usarlo como
 * fuente del guion. Asume HTML servido (SSR); si la página fuera una SPA con JS, el texto
 * vendría casi vacío y se lanza un error para avisar.
 */
export async function fetchCoursePageText(url: string, maxChars = 16000): Promise<string> {
  log.info(`Descargando ficha del curso: ${url}`);
  const html = await withRetry(
    () =>
      withTimeout(
        (async () => {
          const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; video-mkt-gen/1.0)" },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })(),
        30000,
        "fetch course page",
      ),
    "fetch course page",
  );

  const text = htmlToText(html);
  if (text.length < 200) {
    throw new Error("La ficha no devolvió texto útil (¿página renderizada por JS?). Revisa la URL o añade un transcript.");
  }
  log.info(`Ficha extraída: ${text.length} caracteres.`);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Convierte HTML a texto plano legible: quita scripts/estilos/tags, decodifica entidades comunes. */
function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|nav|footer|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|td|th)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&aacute;/gi, "á").replace(/&eacute;/gi, "é").replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó").replace(/&uacute;/gi, "ú").replace(/&ntilde;/gi, "ñ")
    .replace(/&Aacute;/g, "Á").replace(/&Eacute;/g, "É").replace(/&Iacute;/g, "Í")
    .replace(/&Oacute;/g, "Ó").replace(/&Uacute;/g, "Ú").replace(/&Ntilde;/g, "Ñ")
    .replace(/&uuml;/gi, "ü").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&iquest;/gi, "¿").replace(/&iexcl;/gi, "¡").replace(/&euro;/gi, "€")
    .replace(/&#x?[0-9a-f]+;/gi, " ") // resto de entidades numéricas (emojis/símbolos) -> espacio
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
