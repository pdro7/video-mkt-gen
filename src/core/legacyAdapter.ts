/**
 * Adaptador del formato "legacy" (v1, como src/script_sample.json) al ProductionSpec v2.
 *
 * Diferencias que resuelve:
 *  - v1 anida characters/zones/base_images dentro de `video`; v2 los pone en la raíz.
 *  - v1 mete credenciales en los personajes (voice_id, image_seed, flow_character_reference);
 *    v2 deja los personajes SOLO con datos creativos (la voz/imagen se enlaza en config).
 *  - v1 usa nombres con vendor (heygen_motion_prompt); v2 usa `motion_prompt`.
 *  - v1 duplica zone/framing en scene y base_image; v2 los deja solo en base_image.
 *  - v1 usa tiempos GLOBALES (scene_id, time_start, overlay appear_at absolutos); v2 usa
 *    `id`, `estimated_seconds` y tiempos de overlay RELATIVOS al inicio de la escena.
 */

type AnyObj = Record<string, any>;

/** Heurística: ¿el objeto está en formato legacy (v1)? */
export function looksLegacy(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as AnyObj;
  if (r.schema_version === 2) return false;
  const v = (r.video ?? {}) as AnyObj;
  if (v.characters || v.zones || v.base_images) return true; // colecciones anidadas en video
  if (Array.isArray(r.scenes) && r.scenes.some((s: AnyObj) => "scene_id" in s || "heygen_motion_prompt" in s)) {
    return true;
  }
  // video con metadatos pero sin colecciones v2 en la raíz -> legacy
  if (!r.base_images && !r.characters && v && Object.keys(v).length > 0) return true;
  return false;
}

export function adaptLegacySpec(raw: unknown): AnyObj {
  const r = (raw ?? {}) as AnyObj;
  const v = (r.video ?? {}) as AnyObj;

  return {
    schema_version: 2,
    video: {
      client: v.client,
      course_category: v.course_category,
      course_url: v.course_url,
      course_id: v.course_id,
      language: v.language ?? "es-ES",
      version: v.version,
      purpose: v.purpose,
      aspect_ratio: v.aspect_ratio ?? "16:9",
      estimated_seconds: v.duration_seconds,
    },
    characters: adaptCharacters(v.characters ?? r.characters ?? {}),
    zones: v.zones ?? r.zones ?? {},
    base_images: adaptBaseImages(v.base_images ?? r.base_images ?? {}),
    scenes: (r.scenes ?? []).map(adaptScene),
    brand_assets: r.brand_assets ?? {},
  };
}

/** Deja los personajes solo con datos creativos (descarta voice, image_seed, flow refs). */
function adaptCharacters(chars: AnyObj): AnyObj {
  const out: AnyObj = {};
  for (const [id, c] of Object.entries(chars) as [string, AnyObj][]) {
    out[id] = {
      id: c.id ?? id,
      name: c.name,
      gender: c.gender,
      age_range: c.age_range,
      wardrobe: c.wardrobe,
    };
  }
  return out;
}

function adaptBaseImages(bi: AnyObj): AnyObj {
  const out: AnyObj = {};
  for (const [id, b] of Object.entries(bi) as [string, AnyObj][]) {
    out[id] = {
      character: b.character,
      zone: b.zone,
      framing: b.framing,
      used_in_scenes: b.used_in_scenes ?? [],
    };
  }
  return out;
}

function adaptScene(s: AnyObj): AnyObj {
  const start = typeof s.time_start === "number" ? s.time_start : undefined;
  const estimated =
    s.duration ?? (typeof s.time_end === "number" && typeof s.time_start === "number" ? s.time_end - s.time_start : undefined);
  return {
    id: s.scene_id ?? s.id,
    base_image: s.base_image,
    dialogue: s.dialogue,
    tone: s.tone,
    emphasis_words: s.emphasis_words ?? [],
    motion_prompt: s.heygen_motion_prompt ?? s.motion_prompt,
    expressiveness: s.expressiveness,
    estimated_seconds: estimated,
    transition_in: s.transition_in,
    transition_out: s.transition_out,
    camera_movement: s.camera_movement,
    overlays: (s.overlays ?? []).map((o: AnyObj) => adaptOverlay(o, start)),
    persistent_overlays: s.persistent_overlays ?? [],
  };
}

/** Convierte un overlay v1 (tiempos globales) a v2 (tiempos relativos al inicio de escena). */
function adaptOverlay(o: AnyObj, sceneStart?: number): AnyObj {
  const rel = (t: unknown): number | undefined =>
    typeof t === "number" && typeof sceneStart === "number" ? Math.max(0, Math.round((t - sceneStart) * 100) / 100) : (t as number | undefined);

  const { appear_at, disappear_at, type, content, position, ...style } = o;
  return {
    type,
    content,
    position,
    start: rel(appear_at),
    end: rel(disappear_at),
    style: Object.keys(style).length ? style : undefined,
  };
}
