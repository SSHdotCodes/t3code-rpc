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

let cache: { key: string; value: Instances } | null = null;

const safe = (v: unknown, max = 48): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

export function readInstances(settingsPath: string): Instances {
  try {
    const st = statSync(settingsPath);
    const key = `${settingsPath}:${st.mtimeMs}:${st.size}`;
    if (cache?.key === key) return cache.value;
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { providerInstances?: Record<string, unknown> };
    const value: Instances = {};
    for (const [id, entry] of Object.entries(raw.providerInstances ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { driver?: unknown; displayName?: unknown; config?: { agentId?: unknown } };
      value[id] = { driver: safe(e.driver), displayName: safe(e.displayName), agentId: safe(e.config?.agentId) };
    }
    cache = { key, value };
    return value;
  } catch {
    return cache?.value ?? {};
  }
}
