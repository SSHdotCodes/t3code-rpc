// Turn a Decision into the Discord activity payload, resolving art URLs.
import { activityUrl, badgeUrl, ORBIT_FALLBACK_CONDUCTORS, ORBIT_FALLBACK_HELPERS, ORBIT_FALLBACK_MAX, orbitFallbackUrl } from "../art/catalog.js";
const STATUS_DISPLAY = { name: 0, state: 1, details: 2 };
export function largeImageUrl(cfg, art, dynamic) {
    if (art.kind === "activity")
        return activityUrl(cfg.art, art.scene, art.character);
    const { conductor, orbiters, count } = art;
    // A pre-rendered ring is exact when one helper kind fills a small ring.
    const helper = orbiters[0];
    const exactFallback = ORBIT_FALLBACK_CONDUCTORS.includes(conductor) &&
        helper !== undefined &&
        ORBIT_FALLBACK_HELPERS.includes(helper) &&
        orbiters.every((o) => o === helper) &&
        count === orbiters.length &&
        count < ORBIT_FALLBACK_MAX;
    if (!exactFallback && dynamic) {
        const url = dynamic.urlFor(conductor, orbiters, count);
        if (url)
            return url;
    }
    return orbitFallbackUrl(cfg.art, conductor, orbiters, count);
}
export function buildActivity(cfg, decision, dynamic, now = Date.now()) {
    const lines = decision.stateLines.filter(Boolean);
    const idx = cfg.rotateSec > 0 && lines.length > 1 ? Math.floor(now / (cfg.rotateSec * 1000)) % lines.length : 0;
    const activity = {
        name: cfg.appName,
        type: cfg.activityType,
        status_display_type: STATUS_DISPLAY[cfg.statusDisplay],
        details: decision.details,
        state: lines[idx],
        assets: {
            large_image: largeImageUrl(cfg, decision.art, dynamic),
            large_text: decision.largeText,
            small_image: badgeUrl(cfg.art, decision.badge),
            small_text: decision.smallText,
        },
    };
    if (cfg.showElapsed && decision.startedAt)
        activity.timestamps = { start: decision.startedAt };
    const buttons = cfg.buttons.filter((b) => b.label && /^https?:\/\//.test(b.url)).slice(0, 2);
    if (buttons.length)
        activity.buttons = buttons;
    return activity;
}
