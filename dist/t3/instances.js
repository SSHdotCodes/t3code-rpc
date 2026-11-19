// Provider instance labels from T3's settings.json. Only three fields are kept:
// the driver, the user-facing display name and the ACP registry agent id —
// enough to pick the right logo and name. Binary paths, env and anything else
// in the settings never leave this function.
import { readFileSync, statSync } from "node:fs";
const cache = new Map();
const safe = (v, max = 48) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
export function readInstances(settingsPath) {
    let st;
    try {
        st = statSync(settingsPath);
    }
    catch {
        cache.delete(settingsPath);
        return {};
    }
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(settingsPath);
    if (hit?.key === key)
        return hit.value;
    try {
        const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
        const value = {};
        for (const [id, entry] of Object.entries(raw.providerInstances ?? {})) {
            if (!entry || typeof entry !== "object")
                continue;
            const e = entry;
            value[id] = { driver: safe(e.driver), displayName: safe(e.displayName), agentId: safe(e.config?.agentId) };
        }
        cache.set(settingsPath, { key, value });
        return value;
    }
    catch {
        // Transient mid-write parse failure: keep the last good reading for THIS settings file only.
        return hit?.value ?? {};
    }
}
