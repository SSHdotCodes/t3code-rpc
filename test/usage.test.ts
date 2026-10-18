import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { T3Database } from "../src/t3/db.ts";
import { readUsage } from "../src/t3/usage.ts";

const { DatabaseSync } = await import("node:sqlite");
const schema = readFileSync(new URL("./fixtures/schema.sql", import.meta.url), "utf8");
const now = Date.parse("2026-10-17T23:00:00.000Z");
const dayMs = 86_400_000;

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "t3-rpc-usage-"));
  const writer = new DatabaseSync(join(dir, "statev2.sqlite"));
  writer.exec(schema);
  const db = new T3Database(join(dir, "statev2.sqlite"));
  t.after(() => { db.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); });
  function turn(id: string, at: number | null, instance: string, driver: string | null, usage: object | null, extra: object = {}) {
    writer.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, provider, provider_instance_id, driver, status, updated_at, payload_json)
      VALUES (?, ?, ?, ?, 'active', ?, '{}')`).run(`pt:${id}`, instance, instance, driver, new Date(now).toISOString());
    writer.prepare(`INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, started_at, payload_json)
      VALUES (?, 'thread', ?, 'node', 1, 'completed', ?, ?)`).run(id, `pt:${id}`, at === null ? null : new Date(at).toISOString(),
      JSON.stringify({ turnTokenUsage: usage, tokenUsage: { usedTokens: 999999, maxTokens: 1000000 }, text: "PRIVATE MESSAGE", ...extra }));
  }
  return { db, writer, dir, turn };
}

test("sums finalized turn accounting with inclusive ISO window boundaries", (t) => {
  const f = fixture(t);
  const usage = { inputTokens: 100, cachedInputTokens: 60, cacheCreationTokens: 20, outputTokens: 30, reasoningTokens: 10, usageStatus: "complete", usageScope: "main_agent" };
  f.turn("boundary", now - 30 * dayMs, "claudeAgent", "claudeAgent", usage);
  f.turn("new", now - 1000, "codex", "codex", { inputTokens: 200, outputTokens: 50, reasoningTokens: 25 });
  f.turn("too-old", now - 30 * dayMs - 1, "claudeAgent", "claudeAgent", usage);
  f.turn("null-usage", now, "codex", "codex", null);
  const result = readUsage(f.db, { windowDays: 30, now });
  assert.deepEqual(result.totals, { input: 300, cachedInput: 60, cacheCreation: 20, output: 80, reasoning: 35, total: 380, turns: 2 });
  assert.equal(result.byDriver.claudeAgent?.total, 130);
  assert.equal(result.byDriver.codex?.total, 250);
  assert.equal(result.since, now - 30 * dayMs);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("all-time includes older and undated usage, skipping null and absent accounting", (t) => {
  const f = fixture(t);
  f.turn("old", now - 90 * dayMs, "codex", "codex", { inputTokens: 4, outputTokens: 6 });
  f.turn("undated", null, "codex", "codex", { inputTokens: 10 });
  f.turn("null", now, "codex", "codex", null);
  f.turn("absent", now, "codex", "codex", null);
  f.writer.prepare("UPDATE orchestration_v2_projection_provider_turns SET payload_json = '{}' WHERE provider_turn_id = 'absent'").run();
  for (const windowDays of [0, -1]) {
    const result = readUsage(f.db, { windowDays, now });
    assert.equal(result.since, 0);
    assert.equal(result.totals.total, 20);
    assert.equal(result.totals.turns, 2);
  }
});

test("groups by explicit driver or settings/instance fallback, retaining future providers", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ providerInstances: { custom: { driver: "grok", displayName: "PRIVATE LABEL" } } }));
  f.turn("custom", now, "custom", null, { inputTokens: 1, outputTokens: 2 });
  f.turn("grok", now, "grok_grok_build", null, { inputTokens: 3, outputTokens: 4 });
  f.turn("acp", now, "acpRegistry_mistral_vibe", null, { inputTokens: 5, outputTokens: 6 });
  f.turn("future", now, "future", "newDriver", { inputTokens: 7, outputTokens: 8 });
  f.turn("unknown", now, "unmapped", null, { inputTokens: 9, outputTokens: 10 });
  const result = readUsage(f.db, { windowDays: 1, now });
  assert.equal(result.byDriver.grok?.total, 10);
  assert.equal(result.byDriver.acpRegistry?.total, 11);
  assert.equal(result.byDriver.newDriver?.total, 15);
  assert.equal(result.byDriver.unknown?.total, 19);
});

test("re-reads evolving partial accounting instead of caching the current tail", (t) => {
  const f = fixture(t);
  f.turn("partial", now, "codex", "codex", { inputTokens: 2, outputTokens: 1, usageStatus: "partial" });
  assert.equal(readUsage(f.db, { windowDays: 30, now }).totals.total, 3);
  f.writer.prepare("UPDATE orchestration_v2_projection_provider_turns SET payload_json = ? WHERE provider_turn_id = 'partial'").run(JSON.stringify({ turnTokenUsage: { inputTokens: 10, outputTokens: 4, usageStatus: "complete" } }));
  assert.equal(readUsage(f.db, { windowDays: 30, now: now + 1 }).totals.total, 14);
});

test("handles missing DBs without throwing", (t) => {
  const f = fixture(t);
  const db = new T3Database(join(f.dir, "missing.sqlite"));
  t.after(() => db.close());
  assert.equal(readUsage(db, { windowDays: 30, now }).totals.total, 0);
});
