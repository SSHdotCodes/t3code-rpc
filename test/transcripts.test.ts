import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  CACHE_RETENTION_DAYS, MTIME_SLACK_MS, TranscriptReader, decodeTranscriptCache,
  initialCodexScanState, listTranscriptFiles, parseCodexLine, piUsageFormat,
  readTranscriptRecords, refreshTranscript, transcriptFormats,
  type CachedTranscript, type TranscriptProvider, type TranscriptUsageFormat,
} from "../src/t3/transcripts.ts";
import { createUsageJsonReader } from "../src/t3/transcriptJson.ts";
import { readOpenCode, readUsagePage } from "../src/t3/usagePage.ts";

const timestamp = "2026-10-17T10:00:00.000Z";
const now = Date.parse(timestamp) + 60_000;
const providers: TranscriptProvider[] = ["claude", "codex", "grok", "pi"];
const line = (record: unknown) => JSON.stringify(record);
const prefix = (provider: TranscriptProvider): string => provider === "codex"
  ? [
      { type: "session_meta", timestamp, payload: { id: "s1" } },
      { type: "turn_context", payload: { model: "gpt-test" } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "ultrafast" } } },
    ].map(line).join("\n") + "\n"
  : provider === "pi" ? line({ type: "session", id: "s1" }) + "\n" : "";
function record(provider: TranscriptProvider, id: number, output: number): Record<string, unknown> {
  const padding = "工具 output with usage-looking text";
  if (provider === "claude") return { padding, type: "assistant", timestamp, sessionId: "s1", requestId: `r${id}`, costUSD: 0.25,
    message: { id: `m${id}`, model: "claude-test", content: [{ text: padding }],
      usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: output, speed: "fast" } } };
  if (provider === "codex") return { padding, type: "event_msg", timestamp, payload: { type: "token_count", info: {
    last_token_usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 5, output_tokens: output, reasoning_output_tokens: 3 },
  } } };
  if (provider === "grok") return { padding, timestamp: Date.parse(timestamp) / 1000, params: { sessionId: "s1", _meta: { agentTimestampMs: now },
    update: { sessionUpdate: "turn_completed", prompt_id: `p${id}`, usage: { inputTokens: 100, outputTokens: output, costUsdTicks: 2_500_000_000,
      modelUsage: { "grok-test": { inputTokens: 100, cachedReadTokens: 20, cacheCreationTokens: 5, outputTokens: output, reasoningTokens: 3 } } } } } };
  return { padding, type: "message", id: `pi${id}`, timestamp, message: { role: "assistant", provider: "anthropic", model: "requested", responseModel: "actual",
    usage: { input: 100, cacheRead: 20, cacheWrite: 5, output, reasoning: 3, cost: { total: 0.25 } } } };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "t3rpc-transcripts-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function file(path: string) {
  const s = await stat(path);
  return { path, size: s.size, mtimeMs: s.mtimeMs };
}
const format = (provider: TranscriptProvider) => transcriptFormats[provider] as TranscriptUsageFormat<unknown>;

for (const provider of providers) {
  test(`${provider}: full parse preserves all usage fields`, async (t) => {
    const path = join(await fixture(t), "history.jsonl");
    await writeFile(path, prefix(provider) + line(record(provider, 1, 7)) + "\r\n");
    const parsed = (await readTranscriptRecords(path, format(provider)))!;
    assert.equal(parsed.resumed, false);
    assert.deepEqual(parsed.tailRecords, []);
    assert.equal(parsed.position.resumeOffset, (await stat(path)).size);
    assert.equal(parsed.position.guardLength, 64);
    assert.deepEqual(parsed.records, [{
      provider, timestampMs: provider === "grok" ? now : Date.parse(timestamp), sessionId: "s1",
      model: provider === "claude" ? "claude-test" : provider === "codex" ? "gpt-test" : provider === "grok" ? "grok-test" : "anthropic/actual",
      ...(provider === "pi" ? { rateModel: "actual" } : {}),
      totals: { uncachedInputTokens: provider === "codex" || provider === "grok" ? 75 : 100,
        cachedInputTokens: 20, cacheCreationTokens: 5, outputTokens: 7, reasoningTokens: provider === "claude" ? 0 : 3 },
      reportedCostUsd: provider === "codex" ? null : 0.25,
      speed: provider === "claude" ? "fast" : provider === "codex" ? "ultrafast" : "standard",
      dedupeKey: provider === "claude" ? "m1:r1" : provider === "codex" ? null : provider === "grok" ? "s1:p1:grok-test" : JSON.stringify(["pi", "pi1", timestamp, "anthropic/actual"]),
    }]);
  });

  test(`${provider}: append replays partial UTF-8 tails exactly once and carries state`, async (t) => {
    const path = join(await fixture(t), "history.jsonl");
    const firstLine = prefix(provider) + line(record(provider, 1, 7)) + "\r\n";
    const secondLine = Buffer.from(line(record(provider, 2, 11)));
    const split = secondLine.indexOf(Buffer.from("工具")) + 1;
    await writeFile(path, Buffer.concat([Buffer.from(firstLine), secondLine.subarray(0, split)]));
    const first = (await refreshTranscript(await file(path), provider))!;
    assert.equal(first.records.length, 1);
    assert.equal(first.tailRecords.length, 0);
    assert.equal(first.position.resumeOffset, Buffer.byteLength(firstLine));
    assert.equal(await refreshTranscript(await file(path), provider, first), first, "unchanged identity reuses the entry");
    await appendFile(path, secondLine.subarray(split));
    const second = (await refreshTranscript(await file(path), provider, first))!;
    assert.deepEqual(second.records, first.records);
    assert.equal(second.tailRecords.length, 1);
    assert.deepEqual(second.position.state, first.position.state, "tail cannot advance the committed parser state");
    await appendFile(path, "\r\n" + line(record(provider, 3, 17)) + "\n");
    const delta = (await readTranscriptRecords(path, format(provider), second.position))!;
    assert.equal(delta.resumed, true);
    assert.deepEqual(delta.records.map((r) => r.totals.outputTokens), [11, 17]);
    const third = (await refreshTranscript(await file(path), provider, second))!;
    assert.deepEqual(third.records.map((r) => r.totals.outputTokens), [7, 11, 17]);
    assert.equal(third.tailRecords.length, 0);
    assert.deepEqual(third, await refreshTranscript(await file(path), provider));
  });

  test(`${provider}: grown rewrite fails its guard; same-size and shrunk rewrites parse fully`, async (t) => {
    const path = join(await fixture(t), "history.jsonl");
    const content = (n: number) => prefix(provider) + line(record(provider, n, n)) + "\n";
    await writeFile(path, content(7));
    const first = (await refreshTranscript(await file(path), provider))!;
    await writeFile(path, content(8) + line(record(provider, 9, 9)) + "\n");
    const grown = (await readTranscriptRecords(path, format(provider), first.position))!;
    assert.equal(grown.resumed, false);
    assert.deepEqual(grown.records.map((r) => r.totals.outputTokens), [8, 9]);
    const second = (await refreshTranscript(await file(path), provider, first))!;
    assert.deepEqual(second.records, grown.records);
    await writeFile(path, content(8) + line(record(provider, 6, 6)) + "\n");
    const s = await stat(path);
    await utimes(path, s.atime, new Date(second.mtimeMs + 1000));
    const sameSize = (await refreshTranscript(await file(path), provider, second))!;
    assert.deepEqual(sameSize.records.map((r) => r.totals.outputTokens), [8, 6]);
    await writeFile(path, content(4));
    const shrunk = (await refreshTranscript(await file(path), provider, sameSize))!;
    assert.deepEqual(shrunk.records.map((r) => r.totals.outputTokens), [4]);
  });

  test(`${provider}: forked copies dedupe globally without losing repeated codex occurrences`, async (t) => {
    const dir = await fixture(t);
    const content = prefix(provider) + [record(provider, 1, 7), record(provider, 2, 11), record(provider, 3, 7)].map(line).join("\n") + "\n";
    // Grok scans only updates.jsonl, including nested session directories.
    for (const name of ["original", "fork"]) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, provider === "grok" ? "updates.jsonl" : "history.jsonl"), content);
    }
    const reader = new TranscriptReader();
    const records = await reader.read({ files: new Map(), sources: [{ provider, dir }] }, 0, Date.now());
    const seen = new Set<string>();
    const kept = records.filter((r) => r.dedupeKey === null || (!seen.has(r.dedupeKey) && !!seen.add(r.dedupeKey)));
    assert.equal(kept.length, 3);
    assert.deepEqual(kept.map((r) => r.totals.outputTokens), [7, 11, 7]);
  });

  test(`${provider}: oversized projection matches ordinary JSON parsing`, async (t) => {
    const path = join(await fixture(t), "history.jsonl");
    const small = record(provider, 1, 7);
    const ordinary = prefix(provider) + line(small) + "\n";
    await writeFile(path, ordinary);
    const expected = await readTranscriptRecords(path, format(provider));
    for (const paddingFirst of [true, false]) {
      const padding = "工具 \\\"".repeat(60_000);
      const padded = paddingFirst ? { large: padding, ...small } : { ...small, large: padding };
      await writeFile(path, prefix(provider) + line(padded) + "\n");
      const actual = await readTranscriptRecords(path, format(provider), undefined, { streamingThresholdBytes: 512 });
      assert.deepEqual(actual?.records, expected?.records);
      assert.deepEqual(actual?.position.state, expected?.position.state);
    }
  });
}

test("codex suppresses restamped fork/subagent history, preserving the child's identity", () => {
  for (const fork of [{ forked_from_id: "parent" }, { source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }]) {
    const state = initialCodexScanState();
    parseCodexLine(line({ type: "session_meta", timestamp, payload: { id: "child", ...fork } }), state);
    parseCodexLine(line({ type: "session_meta", timestamp, payload: { id: "parent" } }), state);
    parseCodexLine(line({ type: "turn_context", payload: { model: "test" } }), state);
    assert.equal(parseCodexLine(line(record("codex", 1, 7)), state), null);
    const genuine = { ...record("codex", 2, 11), timestamp: new Date(Date.parse(timestamp) + 5000).toISOString() };
    assert.equal(parseCodexLine(line(genuine), state)?.sessionId, "child");
    assert.equal(parseCodexLine(line(genuine), state), null);
  }
});

test("pi handles standalone usage, auxiliary usage, zero-cost fallbacks, and schema stripping", () => {
  const state = { sessionId: "pi-session" };
  const usage = { input: 5, output: 3, cacheRead: 2, cacheWrite: 1, reasoning: 100, cost: { total: 0 } };
  for (const type of ["usage", "compaction", "branch_summary", "message"]) {
    const source = type === "message" ? { message: { role: "toolResult", provider: "discard", model: "discard", usage } } : { provider: "x", model: "y", usage };
    const r = piUsageFormat.parseLine(line({ type, id: "a", timestamp, ...source }), state)[0]!;
    assert.equal(r.model, type === "usage" ? "x/y" : "Tools/summaries");
    assert.equal(r.rateModel, type === "usage" ? "y" : undefined);
    assert.equal(r.totals.reasoningTokens, 3);
    assert.equal(r.reportedCostUsd, null);
  }
  assert.deepEqual(piUsageFormat.parseLine(line({ type: "message", id: "a", timestamp, message: { role: "assistant", provider: "x", model: "y", responseModel: "", usage } }), state), []);
});

test("listing matches extensions, nested subagents, mtime filtering, file symlinks, and directory symlinks", async (t) => {
  const dir = await fixture(t);
  const external = await fixture(t);
  await mkdir(join(dir, "subagents"));
  for (const path of [join(dir, "root.jsonl"), join(dir, "subagents", "agent.jsonl"), join(dir, "ignore.json"), join(dir, "old.jsonl"), join(external, "elsewhere.jsonl")]) await writeFile(path, "{}\n");
  await utimes(join(dir, "old.jsonl"), new Date(0), new Date(0));
  await symlink(join(dir, "root.jsonl"), join(dir, "link.jsonl"));
  await symlink(external, join(dir, "directory-link"), "dir");
  const result = await listTranscriptFiles(dir, 1);
  assert.equal(result.failedPaths, 0);
  assert.deepEqual(result.files.map((f) => f.path), [join(dir, "link.jsonl"), join(dir, "root.jsonl"), join(dir, "subagents", "agent.jsonl")]);
  await writeFile(join(dir, "subagents", "updates.jsonl"), "{}\n");
  assert.deepEqual((await listTranscriptFiles(dir, 0, { fileName: "updates.jsonl" })).files.map((f) => f.path), [join(dir, "subagents", "updates.jsonl")]);
});

function serialize(entry: CachedTranscript) {
  const row = (r: typeof entry.records[number]) => [r.timestampMs, 0, 0, r.totals.uncachedInputTokens, r.totals.cachedInputTokens,
    r.totals.cacheCreationTokens, r.totals.outputTokens, r.totals.reasoningTokens, r.dedupeKey, r.reportedCostUsd, ["standard", "fast", "ultrafast"].indexOf(r.speed), null];
  return { p: entry.provider, s: entry.size, m: entry.mtimeMs, r: entry.records.map(row), t: entry.tailRecords.map(row),
    o: entry.position.resumeOffset, gl: entry.position.guardLength, gh: entry.position.guardHash, cs: entry.position.state };
}

test("readUsagePage resumes the persisted cache, discovers new files, retains deleted history, and never writes T3 files", async (t) => {
  const dir = await fixture(t);
  const oldDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(dir, "isolated-xdg");
  t.after(() => { if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldDataHome; });
  const sources = join(dir, "transcripts");
  await mkdir(sources);
  const path = join(sources, "first.jsonl");
  await writeFile(path, line(record("claude", 1, 7)) + "\n" + line(record("claude", 2, 11)));
  const cached = (await refreshTranscript(await file(path), "claude"))!;
  const cachePath = join(dir, "usage-scan-cache-v5.json");
  const cache = { version: 5, models: ["claude-test"], sessions: ["s1"], sources: { [`claude\0${sources}`]: { dir: sources, volumeId: "" } }, files: { [path]: serialize(cached) } };
  const encoded = JSON.stringify(cache);
  await writeFile(cachePath, encoded);
  await appendFile(path, "\n" + line(record("claude", 3, 17)) + "\n");
  const newPath = join(sources, "new.jsonl");
  await writeFile(newPath, line(record("claude", 4, 19)) + "\n");
  const before = [await readFile(path), await readFile(newPath)];
  const expected = [7, 11, 17, 19].reduce((sum, output) => sum + 125 + output, 0);
  const opts = { windowDays: 30, now: Date.now() };
  const summary = (await readUsagePage(dir, opts))!;
  assert.equal(summary.byDriver.claude?.total, expected);
  assert.equal(summary.byDriver.claude?.sessions, 1);
  assert.equal((await readUsagePage(dir, opts))?.byDriver.claude?.total, expected);
  assert.equal(await readFile(cachePath, "utf8"), encoded);
  assert.deepEqual([await readFile(path), await readFile(newPath)], before);
  await rm(path);
  assert.equal((await readUsagePage(dir, opts))?.byDriver.claude?.total, expected);
});

test("source resolution follows root symlinks; deleted entries use the 92-day retention and 36-hour mtime slack", async (t) => {
  const dir = await fixture(t);
  const root = join(dir, "sessions");
  await mkdir(root);
  const alias = join(dir, "alias");
  await symlink(root, alias, "dir");
  const path = join(root, "retained.jsonl");
  await writeFile(path, line(record("claude", 1, 7)) + "\n");
  const entry = (await refreshTranscript(await file(path), "claude"))!;
  const cutoff = Date.now();
  const old = { ...entry, mtimeMs: cutoff - (CACHE_RETENTION_DAYS + 1) * 86_400_000 };
  const recent = { ...entry, mtimeMs: cutoff - MTIME_SLACK_MS / 2 };
  const files = new Map([[join(root, "old.jsonl"), old], [join(root, "deleted.jsonl"), recent]]);
  const records = await new TranscriptReader().read({ files, sources: [{ provider: "claude", dir: alias }] }, cutoff, cutoff);
  assert.equal(records.length, 2, "live plus retained within mtime slack; older retention removed");
});

test("cache decode rejects invalid offsets/state/rows instead of silently accepting incomplete usage", () => {
  const row = [now, 0, 0, 1, 2, 3, 4, 0, "key", null, 0, null];
  const good = { p: "codex", s: 100, m: now, r: [row], t: [], o: 80, gl: 64, gh: 1, cs: initialCodexScanState() };
  const document = (entry: unknown) => ({ version: 5, models: ["m"], sessions: ["s"], files: { "/x.jsonl": entry } });
  assert.equal(decodeTranscriptCache(document(good)).files.size, 1);
  for (const override of [{ gl: 65 }, { o: -1 }, { cs: {} }, { r: [[...row.slice(0, 3), NaN, ...row.slice(4)]] }]) {
    assert.equal(decodeTranscriptCache(document({ ...good, ...override })).files.size, 0);
  }
});

test("unreadable reads keep the cached entry and are retried", async (t) => {
  const path = join(await fixture(t), "history.jsonl");
  await writeFile(path, line(record("claude", 1, 7)) + "\n");
  const metadata = await file(path);
  const first = (await refreshTranscript(metadata, "claude"))!;
  await rm(path);
  assert.equal(await readTranscriptRecords(path, format("claude")), null);
  assert.equal(await refreshTranscript({ ...metadata, size: metadata.size + 1 }, "claude", first), first);
});

test("opencode metadata reuse invalidates on WAL updates, checkpoints, and window changes", async (t) => {
  const dir = await fixture(t);
  const db = new DatabaseSync(join(dir, "opencode.db"));
  t.after(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  const update = (input: number) => line({ role: "assistant", modelID: "test", time: { created: now }, tokens: { input, output: 1 } });
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("id", "session", now, update(10));
  assert.equal((await readOpenCode(dir, 0))[0]?.uncached, 10);
  assert.equal((await readOpenCode(dir, 0))[0]?.uncached, 10);
  db.prepare("UPDATE message SET data = ?").run(update(20));
  assert.equal((await readOpenCode(dir, 0))[0]?.uncached, 20);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal((await readOpenCode(dir, 0))[0]?.uncached, 20);
  assert.deepEqual(await readOpenCode(dir, now + 1), []);
});

test("usage page window ends at local midnight and excludes empty session IDs from session counts", async (t) => {
  const dir = await fixture(t);
  const localNow = new Date(2026, 9, 17, 10).getTime();
  const tomorrow = new Date(2026, 9, 18).getTime();
  const row = (ts: number, key: string) => [ts, 0, 0, 10, 0, 0, 1, 0, key, null, 0];
  await writeFile(join(dir, "usage-scan-cache-v5.json"), line({ version: 5, models: ["m"], sessions: [""],
    files: { "/deleted.jsonl": { p: "claude", r: [row(localNow, "today"), row(tomorrow, "tomorrow")], t: [] } } }));
  const summary = (await readUsagePage(dir, { windowDays: 30, now: localNow }))!;
  assert.equal(summary.byDriver.claude?.total, 11);
  assert.equal(summary.byDriver.claude?.sessions, 0);
});

test("streaming projector keeps JSON semantics for escaped/duplicate keys, arrays, deep skips, and malformed lines", () => {
  const fields = { type: true, message: { usage: true }, cost: true } as const;
  const cases = [
    '{"discard":"工具\\n\\u0041","type":"user","type":"assistant","mess\\u0061ge":{"usage":{"output":7,"array":[1,null,true,false,{"__proto__":2}]}},"cost":1e400}',
    '{"nested":' + "[".repeat(300) + "0" + "]".repeat(300) + ',"message":{"usage":3}}',
    '{"message":{"usage":1},"message":null}',
  ];
  for (const source of cases) {
    for (const step of [1, 7, 256 * 1024]) {
      const reader = createUsageJsonReader(fields);
      for (let i = 0; i < source.length; i += step) reader.write(source.slice(i, i + step));
      const expected = JSON.parse(source);
      delete expected.discard;
      delete expected.nested;
      assert.deepEqual(reader.finish(), expected);
    }
  }
  for (const source of ['{"message":{"usage":7}} junk', '{"message":{"usage":7}', '{"message":{"usage":7}}{}', '{"type":"bad\\x"}', '{"type":"bad\n"}', '{"cost":01}', '{"cost":1,}', '{"cost":[1,]}']) {
    const reader = createUsageJsonReader(fields);
    reader.write(source);
    assert.equal(reader.finish(), undefined);
  }
});
