// The raw SET_ACTIVITY payload (snake_case, as sent over IPC) and helpers to
// keep it inside Discord's limits.

export interface DiscordActivity {
  name?: string;
  /** 0 Playing, 2 Listening, 3 Watching, 5 Competing */
  type?: 0 | 2 | 3 | 5;
  /** Member-list status text: 0 app name, 1 state, 2 details */
  status_display_type?: 0 | 1 | 2;
  details?: string;
  state?: string;
  details_url?: string;
  state_url?: string;
  timestamps?: { start?: number; end?: number };
  assets?: {
    large_image?: string;
    large_text?: string;
    large_url?: string;
    small_image?: string;
    small_text?: string;
    small_url?: string;
  };
  buttons?: Array<{ label: string; url: string }>;
  instance?: boolean;
}

/** Trim and clamp to `max` code points (never splitting surrogate pairs); Discord wants 2+ chars. */
export function clampText(value: string | undefined, max = 128): string | undefined {
  if (typeof value !== "string") return undefined;
  const chars = [...value.trim()];
  if (chars.length === 0) return undefined;
  let out = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
  if ([...out].length < 2) out = `${out} `.padEnd(2, " ");
  return out;
}

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

export function sanitizeActivity(a: DiscordActivity): DiscordActivity {
  const out: DiscordActivity = {};
  if (a.type !== undefined) out.type = a.type;
  if (a.status_display_type !== undefined) out.status_display_type = a.status_display_type;
  if (a.instance !== undefined) out.instance = a.instance;
  const name = clampText(a.name);
  if (name) out.name = name;
  const details = clampText(a.details);
  if (details) out.details = details;
  const state = clampText(a.state);
  if (state) out.state = state;
  if (isHttp(a.details_url) && a.details_url.length <= 256) out.details_url = a.details_url;
  if (isHttp(a.state_url) && a.state_url.length <= 256) out.state_url = a.state_url;
  if (a.timestamps && (a.timestamps.start || a.timestamps.end)) {
    out.timestamps = {};
    if (a.timestamps.start) out.timestamps.start = Math.floor(a.timestamps.start);
    if (a.timestamps.end) out.timestamps.end = Math.floor(a.timestamps.end);
  }
  if (a.assets) {
    const assets: NonNullable<DiscordActivity["assets"]> = {};
    for (const key of ["large_image", "small_image"] as const) {
      const v = a.assets[key];
      if (typeof v === "string" && v.length > 0 && v.length <= 300) assets[key] = v;
    }
    for (const key of ["large_text", "small_text"] as const) {
      const v = clampText(a.assets[key]);
      if (v) assets[key] = v;
    }
    for (const key of ["large_url", "small_url"] as const) {
      const v = a.assets[key];
      if (isHttp(v) && v.length <= 256) assets[key] = v;
    }
    if (Object.keys(assets).length) out.assets = assets;
  }
  if (a.buttons?.length) {
    const buttons = a.buttons
      .filter((b) => isHttp(b.url) && b.url.length <= 512)
      .map((b) => ({ label: clampText(b.label, 32) ?? "", url: b.url }))
      .filter((b) => b.label)
      .slice(0, 2);
    if (buttons.length) out.buttons = buttons;
  }
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Stable key for change detection. */
export function activityKey(a: DiscordActivity | null): string {
  return a === null ? "null" : JSON.stringify(sortKeys(a));
}
