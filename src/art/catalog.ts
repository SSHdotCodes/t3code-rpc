// Where each piece of art lives. The pre-rendered pack is committed under
// assets/art and served from a public base URL (GitHub raw by default).
//
//   art/<scene>/<character>.gif      activity loops (idle, thinking, …)
//   art/orbit/<conductor>-<helper>-<n>.gif  orchestration fallbacks: a conductor with n helpers of
//                                    one provider (n = 1..6, 6 means "6+"); exact mixed rings are
//                                    rendered on demand (see dynamic.ts)
//   art/badges/<character>.png       small-image provider badges

import type { CharacterKind } from "../render/characters.ts";
import type { Orbiter, SceneKind } from "../render/scenes.ts";

export const ORBIT_FALLBACK_MAX = 6;
export const ORBIT_FALLBACK_CONDUCTORS: CharacterKind[] = ["t3", "claude", "codex"];
export const ORBIT_FALLBACK_HELPERS: CharacterKind[] = ["claude", "codex", "grok"];

export interface ArtConfig {
  baseUrl: string;
  version: string;
}

const join = (base: string, path: string): string => `${base.replace(/\/+$/, "")}/${path}`;
const versioned = (cfg: ArtConfig, path: string): string => `${join(cfg.baseUrl, path)}?v=${encodeURIComponent(cfg.version)}`;

export const activityPath = (scene: Exclude<SceneKind, "orbit">, kind: CharacterKind): string => `${scene}/${kind}.gif`;
export const orbitFallbackPath = (conductor: CharacterKind, helper: CharacterKind, n: number): string =>
  `orbit/${conductor}-${helper}-${Math.max(1, Math.min(ORBIT_FALLBACK_MAX, n))}.gif`;
export const badgePath = (kind: CharacterKind): string => `badges/${kind}.png`;

export const activityUrl = (cfg: ArtConfig, scene: Exclude<SceneKind, "orbit">, kind: CharacterKind): string =>
  versioned(cfg, activityPath(scene, kind));
/** Closest pre-rendered ring: conductor and majority helper snapped to the fallback set. */
export function orbitFallbackUrl(cfg: ArtConfig, conductor: CharacterKind, orbiters: Orbiter[], count: number): string {
  const c = ORBIT_FALLBACK_CONDUCTORS.includes(conductor) ? conductor : "t3";
  const tally = new Map<CharacterKind, number>();
  for (const o of orbiters) if (ORBIT_FALLBACK_HELPERS.includes(o)) tally.set(o, (tally.get(o) ?? 0) + 1);
  const helper = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "codex";
  return versioned(cfg, orbitFallbackPath(c, helper, count));
}
export const badgeUrl = (cfg: ArtConfig, kind: CharacterKind): string => versioned(cfg, badgePath(kind));

/** Canonical, order-independent key for an exact orbit composition. */
export function orbitKey(conductor: CharacterKind, orbiters: Orbiter[], count: number): string {
  const counts = new Map<string, number>();
  for (const o of orbiters) counts.set(o, (counts.get(o) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, c]) => `${k}${c}`);
  const extra = count > orbiters.length ? `-of${count}` : "";
  return `${conductor}__${parts.join("-")}${extra}`;
}

/** Ring order for a composition: grouped by kind so the ring reads as teams. */
export function canonicalOrbiters(orbiters: Orbiter[]): Orbiter[] {
  return [...orbiters].sort((a, b) => a.localeCompare(b));
}
