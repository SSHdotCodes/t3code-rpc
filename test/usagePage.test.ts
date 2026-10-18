import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readOpenCode, readUsagePage, windowStartMs } from "../src/t3/usagePage.ts";

const DAY = 86_400_000;

function cacheFile(dir: string, now: number): void {
  // [ts, model, session, uncached, cached, cacheWrite, output, reasoning, dedupeKey, cost, speed]
  const doc = {
    version: 5,
    models: ["claude-opus-5-5", "gpt-6.1-sol"],
    sessions: ["s1", "s2", "s3"],
    files: {
      "/a.jsonl": { p: "claude", r: [[now - 1000, 0, 0, 10, 1000, 50, 20, 5, "msg-1", null, 0], [now - 2000, 0, 0, 0, 500, 0, 10, 0, "msg-2", null, 0]], t: [] },
      // a forked transcript repeating msg-1 must not count twice
      "/b.jsonl": { p: "claude", r: [[now - 1000, 0, 1, 10, 1000, 50, 20, 5, "msg-1", null, 0]], t: [] },
      "/c.jsonl": { p: "codex", r: [[now - 40 * DAY, 1, 2, 999, 999, 0, 999, 0, null, null, 0]], t: [[now - 5000, 1, 2, 100, 200, 0, 30, 10, null, null, 0]] },
    },
  };
  writeFileSync(join(dir, "usage-scan-cache-v5.json"), JSON.stringify(doc));
}

test("window starts at local midnight N-1 days ago", () => {
  const now = new Date(2026, 9, 18, 15, 30).getTime();
  assert.equal(new Date(windowStartMs(30, now)).toDateString(), new Date(2026, 8, 19).toDateString());
  assert.equal(new Date(windowStartMs(30, now)).getHours(), 0);
  assert.equal(windowStartMs(0, now), 0);
});

test("usage page totals: global dedupe, window, tail records, sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3rpc-usage-"));
  const now = Date.now();
  cacheFile(dir, now);
  process.env.XDG_DATA_HOME = join(dir, "nothing-here");
  const u = (await readUsagePage(dir, { windowDays: 30, now }))!;
  assert.equal(u.source, "t3-usage");
  const claude = u.byDriver.claude!;
  assert.equal(claude.total, 10 + 1000 + 50 + 20 + 500 + 10);
  assert.equal(claude.sessions, 1, "the duplicate in s2 was dropped");
  const codex = u.byDriver.codex!;
  assert.equal(codex.total, 100 + 200 + 30, "old record outside the window, tail record counted");
  assert.equal(u.totals.total, claude.total + codex.total);
  assert.equal(u.totals.input, claude.input + codex.input);
  const all = (await readUsagePage(dir, { windowDays: 0, now }))!;
  assert.equal(all.byDriver.codex!.total, 330 + 999 * 3);
});

test("opencode databases and legacy JSON are read like T3", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3rpc-oc-"));
  const now = Date.now();
  const db = new DatabaseSync(join(root, "opencode.db"));
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  const msg = (role: string, input: number) => JSON.stringify({ role, modelID: "glm-5.2", time: { created: now - 1000 }, tokens: { input, output: 7, reasoning: 3, cache: { read: 40, write: 2 } } });
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m1", "ses1", now - 1000, msg("assistant", 100));
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m2", "ses1", now - 1000, msg("user", 999));
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("m3", "ses1", now - 60 * DAY, msg("assistant", 999));
  db.close();
  mkdirSync(join(root, "storage", "message", "ses2"), { recursive: true });
  writeFileSync(join(root, "storage", "message", "ses2", "m9.json"), JSON.stringify({ id: "m9", sessionID: "ses2", role: "assistant", modelID: "x", time: { created: now - 500 }, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }));
  const recs = await readOpenCode(root, now - 30 * DAY);
  assert.equal(recs.length, 2);
  const m1 = recs.find((r) => r.key === "opencode:m1")!;
  assert.deepEqual([m1.uncached, m1.cached, m1.cacheWrite, m1.output, m1.reasoning], [100, 40, 2, 10, 3], "output includes reasoning, like T3");
  assert.ok(recs.some((r) => r.key === "opencode:m9" && r.session === "ses2"));
});
