# video-gen

Genera videos promocionales horizontales (16:9) con avatares a partir de un **brief de curso**.
Pensado para academias online: **un video por curso** (un brief = una corrida).

## Pipeline

```
brief.json ──► [A] Claude ──► spec.json ──► [B] imágenes ──► [C] voz* ──► [D] video
              (ProductionSpec)              (avatar base)   (opcional)   (HeyGen Avatar IV)
```

1. **spec** — Claude genera el `ProductionSpec` (escenas, zonas, base_images, diálogos, tono, motion prompts) desde el brief y el roster de personajes. Formato 1:1 con `src/script_sample.json`.
2. **images** — Por escena se resuelve la imagen base del personaje. Con `providers.image = "none"` (etapa 1) usa la imagen de referencia tal cual; con `"nano-banana"` la genera por API usando esa referencia.
3. **voice** — *Solo si* `providers.voice = "elevenlabs"* (TTS propio). Por defecto (`"heygen"`) **se omite**: la voz la sintetiza HeyGen con el `voice_id` del personaje (que puede ser una voz de ElevenLabs **conectada dentro de HeyGen**).
4. **videos** — HeyGen (Avatar IV) anima la imagen como *talking photo* diciendo la línea (texto + `voice_id`, o audio propio) + `motion_prompt` + `expressiveness`. La **duración la determina el diálogo**.

> Overlays, transiciones, números animados, banners y movimientos de cámara del spec se **conservan para la etapa 2** (composición con Remotion/ffmpeg) y no se renderizan aún.

## Arquitectura (pensada para producto)

Todo lo externo está detrás de una interfaz + una fábrica que elige la implementación por
config. El core (`src/core`) no conoce proveedores concretos. **Vender = el cliente cambia
`config.json` y `.env`.**

```
src/
  cli/         comandos (generate | spec | images | voice | videos | runs)
  config/      AppConfig (cliente, proveedores, roster de personajes + voz) y credenciales
  core/        brief.ts · spec.ts (ProductionSpec) · types.ts (artefactos) · pipeline.ts
  providers/   llm(Claude) · voice(ElevenLabs) · video(HeyGen) · image(NanoBanana) + factory
  prompts/     plantilla del generador de spec
  storage/     workspace por corrida (output/<runId>/)
  util/        logger y polling
```

Cambiar un proveedor = nueva clase que implementa la interfaz + un `case` en
`src/providers/factory.ts` + valor en `config.json`. El resto no cambia.

## Uso

```bash
npm install
cp .env.example .env            # ANTHROPIC_API_KEY, HEYGEN_API_KEY (GOOGLE_API_KEY opcional)
cp config.example.json config.json
# coloca las imágenes de referencia: Avatars/elena.png, Avatars/marcos.png
# y pon el heygenVoiceId de cada personaje en config.json
#   (en HeyGen: conecta/elige la voz —p. ej. una de ElevenLabs— y copia su voice_id)

# Pipeline completo
npm run dev -- generate --brief inputs/brief.example.json

# Sin gastar en HeyGen (spec + imágenes + voz)
npm run dev -- generate --brief inputs/brief.example.json --skip-videos

# Por etapas sobre una corrida existente
npm run dev -- runs
npm run dev -- images --run <runId>
npm run dev -- voice  --run <runId>
npm run dev -- videos --run <runId>
```

Artefactos en `output/<runId>/`: `spec.json`, `images/`, `audio/`, y URLs de video en `manifest.json`.

## Notas técnicas (verificadas jun-2026)

- **HeyGen Avatar IV** soporta talking photo + `motion_prompt` + `expressiveness` por API; en v2 se activa con `use_avatar_iv_model: true`. Migrar a `/v3/videos` cuando convenga (v2 soportado hasta 31-oct-2026).
- **Voz (por defecto)**: HeyGen sintetiza con `voice.type: "text"` + `voice_id`. Ese `voice_id` puede ser una voz de ElevenLabs conectada dentro de HeyGen (HeyGen llama a ElevenLabs internamente) — no necesitas `ELEVENLABS_API_KEY`. El camino alternativo (`providers.voice="elevenlabs"`) genera el audio fuera y lo sube como asset (`voice.type: "audio"`).
- La generación de movimiento de HeyGen crea **máx. 10s** por clip; mantén las líneas cortas.
- Las rutas exactas de upload/campos de HeyGen conviene confirmarlas en el primer run real; cualquier ajuste es local a `HeyGenProvider`.
