// Where each piece of art lives. The pre-rendered pack is committed under
// assets/art and served from a public base URL (GitHub raw by default).
//
//   art/<scene>/<character>.gif      activity loops (idle, thinking, …)
//   art/orbit/<conductor>-<helper>-<n>.gif  orchestration fallbacks: a conductor with n helpers of
//                                    one provider (n = 1..6, 6 means "6+"); exact mixed rings are
//                                    rendered on demand (see dynamic.ts)
//   art/badges/<character>.png       small-image provider badges
export const ORBIT_FALLBACK_MAX = 6;
export const ORBIT_FALLBACK_CONDUCTORS = ["t3", "claude", "codex"];
export const ORBIT_FALLBACK_HELPERS = ["claude", "codex", "grok"];
const join = (base, path) => `${base.replace(/\/+$/, "")}/${path}`;
const versioned = (cfg, path) => `${join(cfg.baseUrl, path)}?v=${encodeURIComponent(cfg.version)}`;
export const activityPath = (scene, kind) => `${scene}/${kind}.gif`;
export const orbitFallbackPath = (conductor, helper, n) => `orbit/${conductor}-${helper}-${Math.max(1, Math.min(ORBIT_FALLBACK_MAX, n))}.gif`;
export const badgePath = (kind) => `badges/${kind}.png`;
export const activityUrl = (cfg, scene, kind) => versioned(cfg, activityPath(scene, kind));
/** Closest pre-rendered ring: conductor and majority helper snapped to the fallback set. */
export function orbitFallbackUrl(cfg, conductor, orbiters, count) {
    const c = ORBIT_FALLBACK_CONDUCTORS.includes(conductor) ? conductor : "t3";
    const tally = new Map();
    for (const o of orbiters)
        if (ORBIT_FALLBACK_HELPERS.includes(o))
            tally.set(o, (tally.get(o) ?? 0) + 1);
    const helper = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "codex";
    return versioned(cfg, orbitFallbackPath(c, helper, count));
}
export const badgeUrl = (cfg, kind) => versioned(cfg, badgePath(kind));
/** Canonical, order-independent key for an exact orbit composition. */
export function orbitKey(conductor, orbiters, count) {
    const counts = new Map();
    for (const o of orbiters)
        counts.set(o, (counts.get(o) ?? 0) + 1);
    const parts = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, c]) => `${k}${c}`);
    const extra = count > orbiters.length ? `-of${count}` : "";
    return `${conductor}__${parts.join("-")}${extra}`;
}
/** Ring order for a composition: grouped by kind so the ring reads as teams. */
export function canonicalOrbiters(orbiters) {
    return [...orbiters].sort((a, b) => a.localeCompare(b));
}
