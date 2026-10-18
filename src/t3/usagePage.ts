// Token usage exactly as T3 Code's Usage page counts it ("processed tokens"):
// every Claude Code / Codex / Grok / Pi transcript, seeded from T3's
// usage-scan-cache-v5.json and refreshed incrementally, plus OpenCode's own databases, de-duplicated
// globally and windowed by local calendar day. Only usage metadata is retained;
// message text is discarded as each transcript line is parsed.
//
// Mirrors pingdotgg/t3code apps/server/src/usage (usageScanCache.ts,
// usageAggregation.ts) and packages/provider-opencode/src/server/usage.ts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenTotals, UsageSummary } from "../types.ts";
import { decodeTranscriptCache, TranscriptReader, type TranscriptCache, type UsageRecord } from "./transcripts.ts";

export const SCAN_CACHE_FILE_NAME = "usage-scan-cache-v5.json";

// [timestampMs, modelIndex, sessionIndex, uncachedInput, cachedInput, cacheCreation, output, reasoning, dedupeKey, ...]
type SerializedRecord = [number, number, number, number, number, number, number, number, string | null, ...unknown[]];

interface CacheRecord {
  ts: number;
  provider: string;
  session: string;
  uncached: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  key: string | null;
}

interface ParsedCache {
  identity: string;
  mtimeMs: number;
  records: CacheRecord[];
  transcripts: TranscriptCache;
  reader: TranscriptReader;
}

let parsed: ParsedCache | null = null;
const readers = new Map<string, TranscriptReader>();

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Parse T3's scan cache (memoised by file identity; the file only changes when T3 rescans). */
export function readScanCache(userdataDir: string): ParsedCache | null {
  const file = join(userdataDir, SCAN_CACHE_FILE_NAME);
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const identity = `${file}:${st.size}:${st.mtimeMs}`;
  if (parsed?.identity === identity) return parsed;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      version?: number;
      sessions?: string[];
      files?: Record<string, { p?: string; r?: SerializedRecord[]; t?: SerializedRecord[] }>;
    };
    if (doc.version !== 5 || !doc.files) return null;
    const sessions = doc.sessions ?? [];
    const records: CacheRecord[] = [];
    for (const entry of Object.values(doc.files)) {
      const provider = entry.p ?? "unknown";
      for (const r of [...(entry.r ?? []), ...(entry.t ?? [])]) {
        records.push({
          ts: r[0],
          provider,
          session: sessions[r[2]] ?? String(r[2]),
          uncached: num(r[3]),
          cached: num(r[4]),
          cacheWrite: num(r[5]),
          output: num(r[6]),
          reasoning: num(r[7]),
          key: typeof r[8] === "string" ? r[8] : null,
        });
      }
    }
    let reader = readers.get(file);
    if (!reader) readers.set(file, (reader = new TranscriptReader()));
    parsed = { identity, mtimeMs: st.mtimeMs, records, transcripts: decodeTranscriptCache(doc), reader };
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenCode (read live, like T3 does)
// ---------------------------------------------------------------------------

type Sqlite = typeof import("node:sqlite");
let sqliteModule: Sqlite | null = null;
async function sqlite(): Promise<Sqlite> {
  sqliteModule ??= await import("node:sqlite");
  return sqliteModule;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseOpenCodeMessage(source: string, fallback: { id?: string; sessionId?: string; ts?: number }): CacheRecord | null {
  let message: Record<string, unknown>;
  try {
    message = obj(JSON.parse(source));
  } catch {
    return null;
  }
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = obj(message.tokens);
  const cache = obj(usage.cache);
  const modelRef = obj(message.model);
  const model = str(modelRef.id) || str(modelRef.modelID) || str(message.modelID);
  const created = obj(message.time).created;
  const ts = typeof created === "number" ? created : fallback.ts;
  if (!model || typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const reasoning = Math.trunc(num(usage.reasoning));
  const rec: CacheRecord = {
    ts,
    provider: "opencode",
    session: fallback.sessionId || str(message.sessionID),
    uncached: Math.trunc(num(usage.input)),
    cached: Math.trunc(num(cache.read)),
    cacheWrite: Math.trunc(num(cache.write)),
    output: Math.trunc(num(usage.output)) + reasoning,
    reasoning,
    key: null,
  };
  if (rec.uncached + rec.cached + rec.cacheWrite + rec.output === 0) return null;
  const id = fallback.id || str(message.id);
  rec.key = id ? `opencode:${id}` : null;
  return rec;
}

export function openCodeRoot(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}

// The large OpenCode databases otherwise dominate even an unchanged refresh.
// Retain only parsed usage metadata, invalidating on either DB or WAL changes.
const openCodeDatabases = new Map<string, { identity: string; since: number; records: CacheRecord[] }>();
function databaseIdentity(path: string): string {
  return [path, `${path}-wal`].map((file) => {
    try {
      const st = statSync(file);
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch { return "missing"; }
  }).join("/");
}

export async function readOpenCode(root: string, sinceMs: number): Promise<CacheRecord[]> {
  const out: CacheRecord[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(n));
  } catch {
    return out;
  }
  names.sort((a, b) => (a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b)));
  const { DatabaseSync } = await sqlite();
  for (const name of names) {
    const path = join(root, name);
    const identity = databaseIdentity(path);
    const cached = openCodeDatabases.get(path);
    if (cached?.identity === identity && cached.since === sinceMs) {
      for (const record of cached.records) out.push(record);
      continue;
    }
    const records: CacheRecord[] = [];
    let db: InstanceType<Sqlite["DatabaseSync"]> | null = null;
    let succeeded = false;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 100");
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
      for (const table of ["message", "session_message"] as const) {
        if (!tables.has(table)) continue;
        const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
        const hasTime = cols.has("time_created");
        const where = [table === "session_message" ? "type = 'assistant'" : "", hasTime ? "time_created >= ?" : ""].filter(Boolean);
        const sql = `SELECT id, session_id, data, ${hasTime ? "time_created" : "NULL"} AS created FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
        const rows = (hasTime ? db.prepare(sql).all(sinceMs) : db.prepare(sql).all()) as Array<{ id: unknown; session_id: unknown; data: unknown; created: unknown }>;
        for (const row of rows) {
          const rec = parseOpenCodeMessage(str(row.data), {
            id: str(row.id),
            sessionId: str(row.session_id),
            ...(typeof row.created === "number" ? { ts: row.created } : {}),
          });
          if (rec && rec.ts >= sinceMs) records.push(rec);
        }
      }
      succeeded = true;
    } catch {
      /* locked / unreadable database: skip this round */
    } finally {
      db?.close();
    }
    for (const record of records) out.push(record);
    if (succeeded && databaseIdentity(path) === identity) openCodeDatabases.set(path, { identity, since: sinceMs, records });
  }
  // Legacy JSON storage: storage/message/<session>/<message>.json
  const stack = [join(root, "storage", "message")];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (entry.endsWith(".json") && st.mtimeMs >= sinceMs) {
        try {
          const rec = parseOpenCodeMessage(readFileSync(p, "utf8"), {});
          if (rec && rec.ts >= sinceMs) out.push(rec);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Local-midnight of the first day in a trailing window of `days` calendar days (today included). */
export function windowStartMs(days: number, now: number): number {
  if (days <= 0) return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

function emptyTotals(): TokenTotals {
  return { input: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0, total: 0, turns: 0, sessions: 0 };
}

export interface UsagePageResult extends UsageSummary {
  /** When T3 last refreshed its scan cache. */
  cacheUpdatedAt: number;
}

function usageRecord(record: UsageRecord): CacheRecord {
  return {
    ts: record.timestampMs, provider: record.provider, session: record.sessionId,
    uncached: record.totals.uncachedInputTokens, cached: record.totals.cachedInputTokens,
    cacheWrite: record.totals.cacheCreationTokens, output: record.totals.outputTokens,
    reasoning: record.totals.reasoningTokens, key: record.dedupeKey,
  };
}

/**
 * Totals matching T3 Code's Usage page for the trailing `windowDays` local calendar days.
 * Returns null when T3 hasn't written a scan cache yet (open the Usage page once).
 */
export async function readUsagePage(userdataDir: string, opts: { windowDays: number; now?: number; extra?: CacheRecord[] }): Promise<UsagePageResult | null> {
  const cache = readScanCache(userdataDir);
  if (!cache) return null;
  const now = opts.now ?? Date.now();
  const since = windowStartMs(opts.windowDays, now);
  const until = new Date(now);
  until.setHours(24, 0, 0, 0);
  const untilMs = until.getTime();
  const transcripts = await cache.reader.read(cache.transcripts, since, now);
  const openCode = existsSync(openCodeRoot()) ? await readOpenCode(openCodeRoot(), since) : [];
  const seen = new Set<string>();
  const totals = emptyTotals();
  const byDriver: Record<string, TokenTotals> = {};
  const sessions = new Map<string, Set<string>>();
  const add = (r: CacheRecord) => {
    if (r.key !== null) {
      if (seen.has(r.key)) return;
      seen.add(r.key);
    }
    if (r.ts < since || r.ts >= untilMs) return;
    const t = (byDriver[r.provider] ??= emptyTotals());
    for (const bucket of [t, totals]) {
      bucket.input += r.uncached + r.cached + r.cacheWrite;
      bucket.cachedInput += r.cached;
      bucket.cacheCreation += r.cacheWrite;
      bucket.output += r.output;
      bucket.reasoning += r.reasoning;
      bucket.total += r.uncached + r.cached + r.cacheWrite + r.output;
      bucket.turns += 1;
    }
    let set = sessions.get(r.provider);
    if (!set) sessions.set(r.provider, (set = new Set()));
    if (r.session.length > 0) set.add(r.session);
  };
  if (cache.transcripts.files.size === 0 && cache.transcripts.sources.length === 0) {
    // Backward compatibility for cache-only callers without scan metadata.
    for (const r of cache.records) add(r);
  } else for (const r of transcripts) add(usageRecord(r));
  for (const r of opts.extra ?? []) add(r);
  for (const r of openCode) add(r);
  for (const [provider, set] of sessions) {
    byDriver[provider]!.sessions = set.size;
    totals.sessions! += set.size;
  }
  return { windowDays: opts.windowDays, since, totals, byDriver, computedAt: now, source: "t3-usage", cacheUpdatedAt: cache.mtimeMs };
}

export type { CacheRecord };
