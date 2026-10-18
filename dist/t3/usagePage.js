// Token usage exactly as T3 Code's Usage page counts it ("processed tokens"):
// every Claude Code / Codex / Grok / Pi transcript T3 has scanned (from its
// usage-scan-cache-v5.json), plus OpenCode's own databases, de-duplicated
// globally and windowed by local calendar day. Only token numbers, timestamps,
// model and session ids are read — never message text.
//
// Mirrors pingdotgg/t3code apps/server/src/usage (usageScanCache.ts,
// usageAggregation.ts) and packages/provider-opencode/src/server/usage.ts.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const SCAN_CACHE_FILE_NAME = "usage-scan-cache-v5.json";
let parsed = null;
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
/** Parse T3's scan cache (memoised by file identity; the file only changes when T3 rescans). */
export function readScanCache(userdataDir) {
    const file = join(userdataDir, SCAN_CACHE_FILE_NAME);
    let st;
    try {
        st = statSync(file);
    }
    catch {
        return null;
    }
    const identity = `${file}:${st.size}:${st.mtimeMs}`;
    if (parsed?.identity === identity)
        return parsed;
    try {
        const doc = JSON.parse(readFileSync(file, "utf8"));
        if (doc.version !== 5 || !doc.files)
            return null;
        const sessions = doc.sessions ?? [];
        const records = [];
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
        parsed = { identity, mtimeMs: st.mtimeMs, records };
        return parsed;
    }
    catch {
        return null;
    }
}
let sqliteModule = null;
async function sqlite() {
    sqliteModule ??= await import("node:sqlite");
    return sqliteModule;
}
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === "string" ? v : "");
function parseOpenCodeMessage(source, fallback) {
    let message;
    try {
        message = obj(JSON.parse(source));
    }
    catch {
        return null;
    }
    if (message.role !== undefined && message.role !== "assistant")
        return null;
    const usage = obj(message.tokens);
    const cache = obj(usage.cache);
    const modelRef = obj(message.model);
    const model = str(modelRef.id) || str(modelRef.modelID) || str(message.modelID);
    const created = obj(message.time).created;
    const ts = typeof created === "number" ? created : fallback.ts;
    if (!model || typeof ts !== "number" || !Number.isFinite(ts))
        return null;
    const reasoning = Math.trunc(num(usage.reasoning));
    const rec = {
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
    if (rec.uncached + rec.cached + rec.cacheWrite + rec.output === 0)
        return null;
    const id = fallback.id || str(message.id);
    rec.key = id ? `opencode:${id}` : null;
    return rec;
}
export function openCodeRoot() {
    return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}
export async function readOpenCode(root, sinceMs) {
    const out = [];
    let names = [];
    try {
        names = readdirSync(root).filter((n) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(n));
    }
    catch {
        return out;
    }
    names.sort((a, b) => (a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b)));
    const { DatabaseSync } = await sqlite();
    for (const name of names) {
        let db = null;
        try {
            db = new DatabaseSync(join(root, name), { readOnly: true });
            db.exec("PRAGMA busy_timeout = 100");
            const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
            for (const table of ["message", "session_message"]) {
                if (!tables.has(table))
                    continue;
                const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
                const hasTime = cols.has("time_created");
                const where = [table === "session_message" ? "type = 'assistant'" : "", hasTime ? "time_created >= ?" : ""].filter(Boolean);
                const sql = `SELECT id, session_id, data, ${hasTime ? "time_created" : "NULL"} AS created FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
                const rows = (hasTime ? db.prepare(sql).all(sinceMs) : db.prepare(sql).all());
                for (const row of rows) {
                    const rec = parseOpenCodeMessage(str(row.data), {
                        id: str(row.id),
                        sessionId: str(row.session_id),
                        ...(typeof row.created === "number" ? { ts: row.created } : {}),
                    });
                    if (rec && rec.ts >= sinceMs)
                        out.push(rec);
                }
            }
        }
        catch {
            /* locked / unreadable database: skip this round */
        }
        finally {
            db?.close();
        }
    }
    // Legacy JSON storage: storage/message/<session>/<message>.json
    const stack = [join(root, "storage", "message")];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const p = join(dir, entry);
            let st;
            try {
                st = statSync(p);
            }
            catch {
                continue;
            }
            if (st.isDirectory())
                stack.push(p);
            else if (entry.endsWith(".json") && st.mtimeMs >= sinceMs) {
                try {
                    const rec = parseOpenCodeMessage(readFileSync(p, "utf8"), {});
                    if (rec && rec.ts >= sinceMs)
                        out.push(rec);
                }
                catch {
                    /* ignore */
                }
            }
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
/** Local-midnight of the first day in a trailing window of `days` calendar days (today included). */
export function windowStartMs(days, now) {
    if (days <= 0)
        return 0;
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (days - 1));
    return d.getTime();
}
function emptyTotals() {
    return { input: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0, total: 0, turns: 0, sessions: 0 };
}
/**
 * Totals matching T3 Code's Usage page for the trailing `windowDays` local calendar days.
 * Returns null when T3 hasn't written a scan cache yet (open the Usage page once).
 */
export async function readUsagePage(userdataDir, opts) {
    const cache = readScanCache(userdataDir);
    if (!cache)
        return null;
    const now = opts.now ?? Date.now();
    const since = windowStartMs(opts.windowDays, now);
    const openCode = existsSync(openCodeRoot()) ? await readOpenCode(openCodeRoot(), since) : [];
    const seen = new Set();
    const totals = emptyTotals();
    const byDriver = {};
    const sessions = new Map();
    const add = (r) => {
        if (r.key !== null) {
            if (seen.has(r.key))
                return;
            seen.add(r.key);
        }
        if (r.ts < since || r.ts > now + 24 * 3600_000)
            return;
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
        if (!set)
            sessions.set(r.provider, (set = new Set()));
        set.add(r.session);
    };
    for (const r of cache.records)
        add(r);
    for (const r of opts.extra ?? [])
        add(r);
    for (const r of openCode)
        add(r);
    for (const [provider, set] of sessions) {
        byDriver[provider].sessions = set.size;
        totals.sessions += set.size;
    }
    return { windowDays: opts.windowDays, since, totals, byDriver, computedAt: now, source: "t3-usage", cacheUpdatedAt: cache.mtimeMs };
}
