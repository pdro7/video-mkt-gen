import { createLogger } from "../../util/logger.js";
import type { SynthesizeInput, SynthesizedAudio, VoiceProvider } from "./VoiceProvider.js";

const log = createLogger("elevenlabs");

const API_BASE = "https://api.elevenlabs.io";

/**
 * Genera audio por escena con ElevenLabs (text-to-speech). Devuelve MP3.
 * Los parámetros de voz (stability, similarity_boost, style, speaker_boost, model)
 * vienen del personaje configurado.
 */
export class ElevenLabsProvider implements VoiceProvider {
  private apiKey: string;

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizedAudio> {
    const { voiceId, params, text } = input;
    log.info(`Sintetizando voz (${voiceId}, ${params.model})...`);

    const res = await fetch(
      `${API_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: params.model,
          voice_settings: {
            stability: params.stability,
            similarity_boost: params.similarity_boost,
            style: params.style,
            use_speaker_boost: params.speaker_boost,
          },
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`ElevenLabs TTS falló (${res.status}): ${await res.text()}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf, mimeType: "audio/mpeg" };
  }
}
