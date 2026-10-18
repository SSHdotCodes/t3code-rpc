// Small-image badges: the provider's real logo on a full-bleed square
// (Discord crops the small image into a circle itself). Logo sources and
// licenses are listed in assets/src/logos/README.md.

import { CHARACTER_KINDS, type CharacterKind, loadLogo, logo } from "../render/characters.ts";

/** Logos whose file is already a full app-icon tile. */
const TILE_FILES: Partial<Record<CharacterKind, string>> = {
  t3: "t3-nightly.svg",
  grok: "grok.svg",
  cursor: "cursor.svg",
  opencode: "opencode.svg",
  muse: "muse.svg",
  mistral: "mistral.svg",
  pi: "pi.svg",
  antigravity: "antigravity.svg",
};

export function badgeSvg(kind: CharacterKind): string {
  let body: string;
  const tile = TILE_FILES[kind];
  if (tile) {
    // the tile's rounded corners fall outside Discord's circle crop anyway
    const { viewBox, inner } = loadLogo(tile);
    body = `<rect width="256" height="256" fill="#0b1435"/><svg width="256" height="256" viewBox="${viewBox}">${inner}</svg>`;
  } else if (kind === "claude") {
    const { viewBox, inner } = loadLogo("claude-ai-icon.svg");
    body = `<rect width="256" height="256" fill="#f6eee3"/><svg x="56" y="56" width="144" height="144" viewBox="${viewBox}">${inner}</svg>`;
  } else if (kind === "codex") {
    body = `<rect width="256" height="256" fill="#f1f0ff"/><g transform="translate(128 128)">${logo("codex", 196)}</g>`;
  } else if (kind === "gemini") {
    body = `<rect width="256" height="256" fill="#f3f5ff"/><g transform="translate(128 128)">${logo("gemini", 170)}</g>`;
  } else {
    body = `<rect width="256" height="256" fill="#2a2f45"/><g transform="translate(128 128)">${logo("generic", 230)}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">${body}</svg>`;
}

export const BADGE_KINDS: CharacterKind[] = CHARACTER_KINDS;
