/**
 * Proveedor de generación de imágenes para escenas.
 *
 * Punto clave del proyecto: `referenceImages` son las imágenes base del/los avatar(es)
 * (fondo blanco). El proveedor debe usarlas como REFERENCIA para mantener la apariencia
 * consistente del personaje entre escenas. Esto es lo que en las UIs se expresa con "@imagen".
 */
export interface ImageReference {
  /** Bytes de la imagen de referencia (p. ej. la imagen base del avatar). */
  data: Buffer;
  /** MIME, p. ej. "image/png" o "image/jpeg". */
  mimeType: string;
  /** Etiqueta para referenciarla en el prompt (p. ej. el id del avatar). */
  label?: string;
}

export interface GenerateSceneInput {
  prompt: string;
  referenceImages: ImageReference[];
  aspectRatio?: string;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

export interface ImageProvider {
  generateScene(input: GenerateSceneInput): Promise<GeneratedImage>;
}
