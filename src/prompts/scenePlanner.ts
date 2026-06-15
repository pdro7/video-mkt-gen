import type { CourseBrief } from "../core/brief.js";
import type { CharacterConfig } from "../config/schema.js";

/**
 * Construye el prompt para que Claude genere el ProductionSpec completo a partir del
 * brief del curso y el roster de personajes. Pide el JSON EXACTO del formato de spec.
 */
export function buildSpecPrompt(args: {
  brief: CourseBrief;
  characters: CharacterConfig[];
  zones: Record<string, string>;
  constraints: { minScenes: number; maxScenes: number; wordsPerSecond: number };
  aspectRatio: string;
  client: string;
}): { system: string; user: string } {
  const { brief, characters, zones, constraints, aspectRatio, client } = args;

  const charBlock = characters
    .map(
      (c) =>
        `- id: "${c.id}" | nombre: ${c.name}${c.gender ? ` | género: ${c.gender}` : ""}` +
        `${c.ageRange ? ` | edad: ${c.ageRange}` : ""}${c.wardrobe ? ` | vestuario: ${c.wardrobe}` : ""}`,
    )
    .join("\n");

  const zoneBlock = Object.entries(zones)
    .map(([id, desc]) => `- ${id}: ${desc}`)
    .join("\n");

  const points = brief.talking_points.length
    ? brief.talking_points.map((p) => `- ${p}`).join("\n")
    : "(sin puntos específicos; usa el transcript y el mensaje clave)";

  const transcriptBlock = brief.current_transcript
    ? `\n# Transcript del video ACTUAL (mejóralo para vender más; NO lo copies tal cual)\n"""\n${brief.current_transcript.trim()}\n"""\n`
    : "";

  const protagonistLine = brief.protagonist
    ? `\n- PROTAGONISTA: "${brief.protagonist}" lleva el peso del video (la mayoría de escenas y SIEMPRE el gancho inicial y el CTA final). Los demás personajes son de apoyo y aportan variedad.`
    : "";

  const system = [
    "Eres un director creativo y COPYWRITER experto en spots publicitarios cortos con avatares que hablan a cámara.",
    "Tu objetivo es CONVERSIÓN: tomas el mensaje o el transcript y lo haces más vendedor (gancho fuerte en los primeros segundos, beneficios concretos, prueba social, urgencia, CTA claro) SIN inventar datos ni promesas falsas.",
    "Generas un GUION DE PRODUCCIÓN en JSON estricto. Devuelves SOLO JSON válido, sin markdown, sin ```.",
  ].join(" ");

  const user = `# Encargo
Crea el guion de producción de un video promocional para "${client}" sobre el curso
"${brief.course_category}". Objetivo: ${brief.purpose}. Idioma de los textos: ${brief.language}.
${brief.key_message ? `\nMensaje clave: ${brief.key_message}` : ""}
${transcriptBlock}
# Tu trabajo
1) Si hay transcript, REESCRÍBELO para que venda más: gancho en los primeros 2-3 segundos, beneficios concretos, prueba social, urgencia y un CTA accionable. MANTÉN los hechos reales (cifras, "bonificable por Fundae", años, nombres) — NO inventes datos ni promesas.
2) Estructura ese guion mejorado en escenas (formato v2 de abajo), repartiendo las líneas entre los personajes.

# Puntos a comunicar (úsalos además del transcript)
${points}

# Personajes disponibles (usa SOLO estos ids; reparte las escenas entre ellos con criterio)
${charBlock}${protagonistLine}

# Zonas disponibles (LIBRERÍA — referencia por id en base_images; NO inventes zonas nuevas)
${zoneBlock}

# Reglas (formato v2)
- Entre ${constraints.minScenes} y ${constraints.maxScenes} escenas. Cada escena = UNA línea de diálogo.
- La duración del video la determina el diálogo (el motor rinde según el habla); escribe líneas naturales y concisas. Cada línea debe poder decirse en ~2 a ~9 segundos (ritmo ~${constraints.wordsPerSecond} palabras/seg). NO superes ~9s por línea.
- Relación de aspecto: ${aspectRatio}.
- Usa zonas de la LIBRERÍA (referencia su id en cada base_image). NO inventes zonas ni incluyas el objeto "zones" en la salida. Elige zonas variadas que peguen con el tono de cada momento.
- Define "base_images" (combinación personaje+zona+encuadre) REUTILIZADAS en varias escenas ("used_in_scenes").
- La escena referencia un "base_image" por id. El personaje, la zona y el encuadre se DERIVAN del base_image: NO los repitas en la escena.
- "motion_prompt": instrucción breve de movimiento/gesto (talking-head) con la forma [parte del cuerpo] + [acción] + [emoción/intensidad]. Concisa.
- "expressiveness": "low" | "medium" | "high" según la energía de la escena.
- ESCENAS DINÁMICAS (avatar en movimiento): marca con el campo "motion" un total de aproximadamente ${brief.max_dynamic_scenes} escenas (apunta a ese número, no menos, salvo que haya menos escenas que ese total). OBLIGATORIO incluir la PRIMERA (gancho) y la ÚLTIMA (CTA/cierre); el resto, repártelas entre las escenas de mayor impacto. Las demás escenas NO llevan "motion" (van talking-head).
- El "motion" (en inglés, conciso) describe el movimiento de ESA escena, estilo PLANO MEDIO favorecedor. Escribe uno DISTINTO y a medida para CADA escena dinámica — NUNCA repitas la misma frase entre escenas. Varía el tipo de movimiento según el tono: p. ej. "gentle slow push-in with subtle hand gestures", "takes a couple of confident steps toward the camera", "slow lateral camera drift", "leans in with an open-hand inviting gesture", "slow arc toward the camera", "energetic delivery with expressive hand gestures". NO caminata larga desde el fondo, NO planos generales lejanos.
- Una escena con "motion" NO necesita "motion_prompt" ni "expressiveness" (esos son para talking-head).
- "estimated_seconds" por escena: estimación coherente (no es exacta). NO describas la cara del personaje (su apariencia viene de su imagen de referencia).
- Personajes: SOLO datos creativos (id, name, gender, age_range, wardrobe). NO incluyas voces ni ids de herramientas.
- Overlays (opcionales, etapa 2): "type", "content", "position", y tiempos "start"/"end" RELATIVOS al inicio de la escena (segundos desde que empieza la escena). "persistent_overlays" referencia ids de "brand_assets".

# Formato de salida (JSON EXACTO; respeta los nombres de campo)
{
  "schema_version": 2,
  "video": { "client": "${client}", "course_category": "${brief.course_category}", "course_url": ${JSON.stringify(brief.course_url ?? "")}, "estimated_seconds": <estimado>, "aspect_ratio": "${aspectRatio}", "language": "${brief.language}", "version": ${JSON.stringify(brief.version ?? "A")}, "purpose": "${brief.purpose}" },
  "characters": { "<id>": { "id": "<id>", "name": "<nombre>", "gender": "<...>", "age_range": "<...>", "wardrobe": "<...>" } },
  "base_images": { "IMG_1": { "character": "<id>", "zone": "<ZONE_id de la librería>", "framing": "<encuadre>", "used_in_scenes": [1,2] } },
  "scenes": [
    {
      "id": 1, "base_image": "IMG_1",
      "dialogue": "<gancho inicial>", "tone": "<tono>", "emphasis_words": ["..."],
      "motion": "<movimiento a medida, en inglés, DISTINTO por escena — ver reglas>", "estimated_seconds": 4,
      "transition_in": "cut", "transition_out": "cut", "overlays": [], "persistent_overlays": []
    },
    {
      "id": 2, "base_image": "IMG_2",
      "dialogue": "<línea talking-head>", "tone": "<tono>", "emphasis_words": ["..."],
      "motion_prompt": "<gesto breve>", "expressiveness": "medium", "estimated_seconds": 4,
      "transition_in": "cut", "transition_out": "cut",
      "overlays": [{ "type": "lower_third", "content": "<texto>", "position": "lower_left", "start": 0.5, "end": 4 }],
      "persistent_overlays": []
    }
  ],
  "brand_assets": {}
}

(Escena 1 = DINÁMICA: lleva "motion", sin motion_prompt/expressiveness. Escena 2 = talking-head: lleva motion_prompt/expressiveness, sin motion.)
Responde SOLO con ese JSON.`;

  return { system, user };
}
