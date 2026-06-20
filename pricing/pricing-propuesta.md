# Propuesta de pricing — Vídeos promocionales por curso (Ciberaula)

> **Para:** equipo financiero · **De:** producción de vídeo · **Fecha:** 2026-06-19
> **Objetivo:** dar los datos de coste reales (medidos) y la estructura de variables para
> que finanzas defina el precio de venta de este tipo de vídeos.
> **Moneda:** todos los costes de API están en **USD**. Pendiente decidir FX y precio en **EUR**.

---

## 1. Qué se vende

Un **vídeo promocional por curso**, generado con IA, listo para publicar:

- Formato **16:9**, duración **~60–70 s** (~9 escenas).
- Avatares de marca consistentes (mismo personaje en todas las escenas).
- Mezcla de escenas **talking-head** (avatar a cámara) y **dinámicas** (avatar en movimiento, cámara cinematográfica), con opción de escena **a dúo** (dos avatares).
- Guion orientado a conversión, generado desde la ficha del curso (sin inventar datos).
- El cliente solo cambia credenciales/configuración: **escalable a muchos cursos**.

---

## 2. Estructura de costes

### 2.1 Coste variable por vídeo (APIs de generación)

Precios unitarios actuales (✅ medidos / ≈ estimados):

| Componente | Coste unitario | Notas |
|---|---|---|
| Guion (Claude) | ≈ $0.40 / vídeo | estimado (tokens) |
| Imagen base (Nano Banana Pro) | ≈ $0.12 / imagen | ≈ estimado |
| Escena talking-head (HeyGen Avatar IV) | ≈ $0.10 / escena | ✅ oficial (20 créditos/min) |
| Escena dinámica — Veo fast (fal) | ≈ $1.20 / clip | ✅ medido |
| Escena dinámica — Veo std/quality (fal) | ≈ $3.20 / clip | ✅ medido |
| Escena dúo / Cinematic (HeyGen) 720p | ≈ $4.88 / clip | ✅ medido |
| Escena dúo / Cinematic (HeyGen) 1080p | ≈ $12 / clip | ✅ medido |
| Voz (ElevenLabs TTS/STS) | ≈ $0.07 / escena | ≈ estimado |
| Montaje + post (ffmpeg) | $0 | local |

> **Las escenas dinámicas y, sobre todo, el dúo (Cinematic) dominan el coste variable.** El resto es marginal.

### 2.2 Coste variable — ejemplos REALES medidos (sesión 2026-06-18)

Dos versiones del mismo curso, calculadas automáticamente por el sistema (`costs.md` por run):

| Vídeo | Composición | Coste API (1 pasada) |
|---|---|---|
| **A — Mixto** | 5 dinámicas (Veo fast) + 4 talking-head | **$8.51** |
| **B — Todo dinámico** | 8 dinámicas (Veo fast) + 1 dúo (Cinematic 720p) | **$16.52** |

> Estos importes son de los **clips finales**. El gasto real de esa sesión fue mayor por
> **iteraciones** (re-tiradas por QA/pronunciación/glitches): ~$15 el A y ~$17 incrementales el B.

### 2.3 Escenarios de producción por estrategia (9 escenas)

| Escenario | Dinámicas | Coste API/gen |
|---|---|---|
| Todo HeyGen Cinematic 720p (5 din + 4 TH) | 5 × $4.88 | ~$25–26 |
| Mixto premium (3 Cinematic hero + 6 TH) | 3 × $4.88 | ~$16–17 |
| Veo fast (5 din + 4 TH) | 5 × $1.20 | ~$8 |
| Mínimo (2 din Veo fast + 7 TH) | 2 × $1.20 | ~$4–5 |

> **Palanca de coste principal:** nº de escenas dinámicas, motor (Veo fast vs Cinematic) y resolución.

### 2.4 Costes fijos a amortizar (NO por vídeo)

Suscripciones mensuales que hay que repartir entre los vídeos producidos:

| Servicio | Coste aprox. | Modelo |
|---|---|---|
| HeyGen | ~$99 / mes (plan Pro) | suscripción + créditos API aparte |
| ElevenLabs | ~$22–99 / mes | suscripción por uso |
| Claude (Anthropic) | pago por uso | incluido en variable |
| Google / fal | pago por uso | incluido en variable |

> Ejemplo de amortización: ~$120/mes de fijos ÷ **20 vídeos/mes ≈ $6/vídeo**. A más volumen, menos coste fijo por vídeo.

### 2.5 Buffer de iteraciones (QA)

Re-render de escenas por pronunciación, movimiento o glitches: **+20–40%** sobre el coste variable. Recomendado presupuestar **+30%**.

### 2.6 Coste de operación humana (el mayor coste oculto)

Tiempo de una persona por vídeo: revisar guion, elegir tomas, ajustar prompts, QA final, entrega. **Asignar una tarifa/hora** y estimar horas/vídeo (pendiente medir; estimación inicial 0,5–1,5 h/vídeo según iteraciones).

---

## 3. Coste TOTAL estimado por vídeo (ejemplo)

Escenario mixto premium (referencia), sin contar tiempo humano:

```
Generación API            ~$16
+ subs amortizadas        ~$6    (a 20 vídeos/mes)
+ buffer iteración (+30%) ~$5
──────────────────────────────
Coste directo             ~$27 / vídeo
+ tiempo de operación      $?    (tarifa/hora × horas)  ← definir con finanzas
+ margen comercial         $?    ← definir con finanzas
══════════════════════════════
PRECIO AL CLIENTE          $?
```

> **Lectura clave:** el coste de **infraestructura/API es bajo** (~$5–27/vídeo según calidad).
> El precio NO debería anclarse al coste de API, sino al **valor** (un vídeo promocional profesional
> equivalente por agencia cuesta cientos/miles de €) y al **tiempo de operación**.

---

## 4. Tiempo de producción y capacidad

- **Tiempo de máquina por vídeo (actual, serial):** ~24–26 min (perfecto a la primera).
- **Con paralelización (mejora planificada):** ~6–7 min.
- Implicación de **capacidad/escala:** el cuello de botella real es el **tiempo humano de QA**, no la máquina. A definir cuántos vídeos/mes por operador para el modelo de costes.

---

## 5. Marcos de pricing a considerar (decisión de finanzas)

1. **Cost-plus:** coste directo × margen. Simple, pero infravalora (el coste de API es muy bajo).
2. **Basado en valor:** precio según el valor para el cliente (ahorro vs agencia tradicional, conversión). Recomendado como ancla.
3. **Por paquetes / volumen:** precio por lote de vídeos (p. ej. renovar todo un catálogo de cursos) con descuento por volumen — encaja con el caso Ciberaula (muchos cursos).
4. **Suscripción / retainer:** cuota mensual por X vídeos/mes (ingreso recurrente, amortiza fijos).
5. **Tiers por calidad:** Básico (Veo fast, ~$8 API) / Premium (Cinematic + dúo, ~$16–26 API) a distinto precio.

---

## 6. Variables que mueven el coste (resumen)

| Variable | Efecto en coste |
|---|---|
| Nº de escenas dinámicas | ↑ alto |
| Motor dinámico (Veo fast vs Cinematic) | ↑↑ (Cinematic ~4× más caro) |
| Resolución (720p vs 1080p Cinematic) | ↑↑ (~$5 → ~$12) |
| Escenas a dúo (multi-avatar) | ↑ (cada una ~$5) |
| Iteraciones / QA | ↑ +20–40% |
| Volumen mensual | ↓ coste fijo por vídeo |

---

## 7. Supuestos y riesgos

- **HeyGen Cinematic es beta:** riesgo de cambio de precio/disponibilidad; su API **reserva ~$10+ por job** (necesidad de colchón de saldo/tesorería).
- Varios unitarios (Claude, Nano Banana, ElevenLabs) son **estimados**; conviene afinarlos con facturas reales.
- **FX USD→EUR** no aplicado; definir tipo y si se traslada el riesgo cambiario al precio.
- Iteraciones no registradas automáticamente → el buffer +30% es estimación.

---

## 8. Preguntas abiertas para finanzas

1. ¿Modelo de pricing objetivo? (valor / paquete / suscripción / tiers)
2. ¿Tarifa/hora para imputar el tiempo de operación y horas/vídeo asumidas?
3. ¿Margen objetivo?
4. ¿Volumen esperado (vídeos/mes) para amortizar fijos?
5. ¿Precio en EUR y tratamiento del FX?
6. ¿Calidad estándar de la oferta? (define el coste API base: Veo fast vs Cinematic)

---

## Anexo · Fuente de los datos

- Precios unitarios: `src/core/costs.ts` (`UNIT_COSTS`) y guía interna (`docs/guia.html` → Costes).
- Cálculo automático por vídeo: `costs.md` en cada run (`output/<run>/costs.md`).
- Tiempos: `output/<run>/timings.md` y guía → Duración / rendimiento.
- Ejemplos reales: runs `run_2026-06-18_16-04-40` ($8.51) y `run_2026-06-18_alldyn` ($16.52).
