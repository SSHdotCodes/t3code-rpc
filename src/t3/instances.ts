// Provider instance labels from T3's settings.json. Only three fields are kept:
// the driver, the user-facing display name and the ACP registry agent id —
// enough to pick the right logo and name. Binary paths, env and anything else
// in the settings never leave this function.

import { readFileSync, statSync } from "node:fs";

export interface InstanceInfo {
  driver?: string;
  displayName?: string;
  agentId?: string;
}

export type Instances = Record<string, InstanceInfo>;

const cache = new Map<string, { key: string; value: Instances }>();

const safe = (v: unknown, max = 48): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

export function readInstances(settingsPath: string): Instances {
  let st;
  try {
    st = statSync(settingsPath);
  } catch {
    cache.delete(settingsPath);
    return {};
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(settingsPath);
  if (hit?.key === key) return hit.value;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { providerInstances?: Record<string, unknown> };
    const value: Instances = {};
    for (const [id, entry] of Object.entries(raw.providerInstances ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { driver?: unknown; displayName?: unknown; config?: { agentId?: unknown } };
      value[id] = { driver: safe(e.driver), displayName: safe(e.displayName), agentId: safe(e.config?.agentId) };
    }
    cache.set(settingsPath, { key, value });
    return value;
  } catch {
    // Transient mid-write parse failure: keep the last good reading for THIS settings file only.
    return hit?.value ?? {};
  }
}
