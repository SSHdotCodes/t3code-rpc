// Provider instance labels from T3's settings.json. Only three fields are kept:
// the driver, the user-facing display name and the ACP registry agent id —
// enough to pick the right logo and name. Binary paths, env and anything else
// in the settings never leave this function.
import { readFileSync, statSync } from "node:fs";
let cache = null;
const safe = (v, max = 48) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
export function readInstances(settingsPath) {
    try {
        const st = statSync(settingsPath);
        const key = `${settingsPath}:${st.mtimeMs}:${st.size}`;
        if (cache?.key === key)
            return cache.value;
        const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
        const value = {};
        for (const [id, entry] of Object.entries(raw.providerInstances ?? {})) {
            if (!entry || typeof entry !== "object")
                continue;
            const e = entry;
            value[id] = { driver: safe(e.driver), displayName: safe(e.displayName), agentId: safe(e.config?.agentId) };
        }
        cache = { key, value };
        return value;
    }
    catch {
        return cache?.value ?? {};
    }
}
