import type { CourseBrief } from "../core/brief.js";
import type { CharacterConfig } from "../config/schema.js";

/**
 * Construye el prompt para que Claude genere el ProductionSpec completo a partir del
 * brief del curso y el roster de personajes. Pide el JSON EXACTO del formato de spec.
 */
export function buildSpecPrompt(args: {
  brief: CourseBrief;
  sourceText?: string;
  characters: CharacterConfig[];
  zones: Record<string, string>;
  constraints: { minScenes: number; maxScenes: number; wordsPerSecond: number };
  aspectRatio: string;
  client: string;
}): { system: string; user: string } {
  const { brief, sourceText, characters, zones, constraints, aspectRatio, client } = args;

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
    : "(sin puntos específicos; usa la ficha del curso y el mensaje clave)";

  const sourceBlock = sourceText
    ? `\n# Ficha del curso (FUENTE PRINCIPAL — extrae de aquí los DATOS REALES: temario, duración, precio, Fundae, modalidad, público objetivo, certificación, estadísticas; NO inventes)\n"""\n${sourceText.trim()}\n"""\n`
    : "";

  const transcriptBlock = brief.current_transcript
    ? `\n# Transcript del video actual (APOYO opcional para el tono; NO lo copies, prioriza la ficha)\n"""\n${brief.current_transcript.trim()}\n"""\n`
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
${sourceBlock}${transcriptBlock}
# Tu trabajo
1) A partir de la FICHA del curso (y el transcript de apoyo si lo hay), redacta un guion VENDEDOR: gancho en los primeros 2-3 segundos, beneficios concretos, prueba social, urgencia y un CTA accionable. Extrae y USA los datos reales de la ficha (duración, "bonificable por Fundae", temario, modalidad, público, certificación, estadísticas) — NO inventes datos ni promesas.
2) Estructura ese guion en escenas (formato v2 de abajo), repartiendo las líneas entre los personajes.

# Puntos a comunicar (úsalos además de la ficha)
${points}

# Personajes disponibles (usa SOLO estos ids; reparte las escenas entre ellos con criterio)
${charBlock}${protagonistLine}

# Zonas disponibles (LIBRERÍA — referencia por id en base_images; NO inventes zonas nuevas)
${zoneBlock}

# Reglas (formato v2)
- Entre ${constraints.minScenes} y ${constraints.maxScenes} escenas. Prefiere MENOS escenas y más ricas: una escena puede llevar 1 a 3 frases de diálogo, no solo una línea.
- EVITA REDUNDANCIA (regla dura): NO repitas la misma zona en dos escenas, y NUNCA pongas dos escenas visualmente similares (misma zona o mismo tipo de set) — menos aún adyacentes. Si dos ideas caerían en el mismo escenario, FÚNDELAS en UNA sola escena que diga ambos diálogos. No pongas al mismo personaje en dos escenas seguidas salvo que sea intencional.
- La duración la determina el diálogo (el motor rinde según el habla); líneas naturales y concisas, ~${constraints.wordsPerSecond} palabras/seg. Una escena talking-head puede ser larga (varias frases). Una escena DINÁMICA debe caber en ~8s de habla (≈18-20 palabras máx): si necesita más, hazla talking-head.
- CLARIDAD PARA TTS (la voz se sintetiza desde el texto): evita el choque de vocales idénticas entre palabras (p. ej. "vas a aprenderlo", "a automatizar" → reescríbelo: "lo aprenderás", "a poner en marcha"). Evita anglicismos ("copy", "engagement" → "textos", "interacción") y siglas sueltas de 2 letras; si usas un acrónimo, prefiere su forma desarrollada. Usa puntuación natural para marcar pausas.
- Relación de aspecto: ${aspectRatio}.
- Usa zonas de la LIBRERÍA (referencia su id en cada base_image). NO inventes zonas ni incluyas el objeto "zones" en la salida. Cada zona se usa COMO MÁXIMO una vez; elige zonas variadas que peguen con el tono de cada momento.
- Define "base_images" (combinación personaje+zona+encuadre). Reutiliza un mismo base_image SOLO si es exactamente la misma toma; no crees dos base_images casi idénticos.
- La escena referencia un "base_image" por id. El personaje, la zona y el encuadre se DERIVAN del base_image: NO los repitas en la escena.
- "motion_prompt": instrucción breve de movimiento/gesto (talking-head) con la forma [parte del cuerpo] + [acción] + [emoción/intensidad]. Concisa.
- "expressiveness": "low" | "medium" | "high" según la energía de la escena.
- ESCENAS DINÁMICAS (avatar en movimiento, motor Veo): aproximadamente la MITAD de las escenas deben ser dinámicas (marca esas con "motion"). DISEÑA esas escenas con una acción donde el movimiento encaje de verdad: el avatar camina por el espacio, recorre la zona, se acerca a cámara o entra en plano. REPÁRTELAS a lo largo del video alternando con las talking-head (NO todas seguidas). OBLIGATORIO que la PRIMERA (gancho) y la ÚLTIMA (CTA/cierre) sean dinámicas. Cada dinámica debe caber en ~8s (≈18-20 palabras); si necesita más texto, hazla talking-head. Las talking-head (la otra mitad) son mensajes a cámara en escenarios estáticos.
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
