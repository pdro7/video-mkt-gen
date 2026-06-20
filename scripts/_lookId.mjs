// Helper para los scripts de prueba: lee el heygenLookId de un personaje desde config.json
// (gitignored), para no hardcodear identificadores de cuenta en el repo.
import { readFileSync } from "node:fs";

function character(characterId) {
  const cfg = JSON.parse(readFileSync("config.json", "utf8"));
  const c = (cfg.characters || []).find((x) => x.id === characterId);
  if (!c) throw new Error(`No existe el personaje "${characterId}" en config.json`);
  return c;
}

export function lookId(characterId) {
  const c = character(characterId);
  if (!c.heygenLookId) throw new Error(`No hay heygenLookId para "${characterId}" en config.json`);
  return c.heygenLookId;
}

export function elevenVoiceId(characterId) {
  const c = character(characterId);
  const v = c.elevenLabs?.voiceId;
  if (!v) throw new Error(`No hay elevenLabs.voiceId para "${characterId}" en config.json`);
  return v;
}
