import type { TokenTotals, UsageSummary } from "../types.ts";
import { T3Database } from "./db.ts";
import { driverResolver } from "./state.ts";

const dayMs = 86_400_000;
interface UsageRow {
  driver: string | null;
  provider_instance_id: string | null;
  input: number;
  cachedInput: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
  turns: number;
}
const empty = (): TokenTotals => ({ input: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0, total: 0, turns: 0 });

// Input already includes cache reads/writes; output already includes reasoning.
// Select numeric aggregates only, never the full payload or context tokenUsage.
const usageSelect = `SELECT pt.driver,
  COALESCE(pt.provider_instance_id, pt.provider) AS provider_instance_id,
  SUM(COALESCE(json_extract(v.payload_json, '$.turnTokenUsage.inputTokens'), 0)) AS input,
  SUM(COALESCE(json_extract(v.payload_json, '$.turnTokenUsage.cachedInputTokens'), 0)) AS cachedInput,
  SUM(COALESCE(json_extract(v.payload_json, '$.turnTokenUsage.cacheCreationTokens'), 0)) AS cacheCreation,
  SUM(COALESCE(json_extract(v.payload_json, '$.turnTokenUsage.outputTokens'), 0)) AS output,
  SUM(COALESCE(json_extract(v.payload_json, '$.turnTokenUsage.reasoningTokens'), 0)) AS reasoning,
  COUNT(*) AS turns
  FROM orchestration_v2_projection_provider_turns v
  LEFT JOIN orchestration_v2_projection_provider_threads pt ON pt.provider_thread_id = v.provider_thread_id`;
const usageFilter = "json_type(v.payload_json, '$.turnTokenUsage') = 'object'";
const usageGroup = "GROUP BY pt.driver, COALESCE(pt.provider_instance_id, pt.provider)";

export function readUsage(db: T3Database, opts: { windowDays: number; now?: number }): UsageSummary {
  const now = opts.now ?? Date.now();
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : 30;
  const since = windowDays <= 0 ? 0 : now - windowDays * dayMs;
  const summary: UsageSummary = { windowDays, since, totals: empty(), byDriver: {}, computedAt: now };
  const resolveDriver = driverResolver(db.settingsPath);
  try {
    if (!db.hasV2) return summary;
    // Live 30-day aggregation measured ~5 ms, so daily bucket caching is not
    // needed. Always re-reading also picks up partial/late accounting updates.
    const window = windowDays <= 0 ? "" : "v.started_at >= ? AND ";
    const rows = db.all<UsageRow>(`${usageSelect} WHERE ${window}${usageFilter} ${usageGroup}`,
      ...(windowDays <= 0 ? [] : [new Date(since).toISOString()]));
    for (const row of rows) {
      const driver = row.driver ?? resolveDriver(row.provider_instance_id) ?? "unknown";
      // defineProperty avoids special Object.prototype keys from future drivers.
      if (!Object.hasOwn(summary.byDriver, driver)) Object.defineProperty(summary.byDriver, driver, { value: empty(), enumerable: true });
      const totals = summary.byDriver[driver]!;
      for (const field of ["input", "cachedInput", "cacheCreation", "output", "reasoning", "turns"] as const) {
        const value = Number(row[field]);
        if (Number.isFinite(value) && value >= 0) { totals[field] += value; summary.totals[field] += value; }
      }
      totals.total = totals.input + totals.output;
    }
    summary.totals.total = summary.totals.input + summary.totals.output;
  } catch { /* Missing/rotating/busy DBs can be retried on the next usage poll. */ }
  return summary;
}
