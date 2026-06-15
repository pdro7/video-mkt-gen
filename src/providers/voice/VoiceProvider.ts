import type { ElevenLabsVoiceParams } from "../../config/schema.js";

/** Proveedor de voz: convierte el diálogo de una escena en audio. */
export interface SynthesizeInput {
  text: string;
  voiceId: string;
  params: ElevenLabsVoiceParams;
  language?: string;
}

export interface SynthesizedAudio {
  data: Buffer;
  mimeType: string;
}

export interface VoiceProvider {
  synthesize(input: SynthesizeInput): Promise<SynthesizedAudio>;
}
