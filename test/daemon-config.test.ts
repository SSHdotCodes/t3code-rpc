import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DynamicArt } from "../src/art/dynamic.ts";
import { configPath, loadConfig, resetConfig, setConfigValue, unsetConfigValue } from "../src/config.ts";
import { MoodStabilizer, rotateLogIfNeeded } from "../src/daemon.ts";
import { readInstances } from "../src/t3/instances.ts";

function withTempHome(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "t3rpc-cfg-"));
  const prev = process.env.T3CODE_RPC_HOME;
  process.env.T3CODE_RPC_HOME = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.T3CODE_RPC_HOME;
    else process.env.T3CODE_RPC_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("MoodStabilizer clears pending candidate when returning to shown mood", () => {
  const s = new MoodStabilizer(2000, 6000);
  // First mood shows immediately
  assert.equal(s.accept("single:coding", 0), true);
  // Brief flicker to searching at t=10s starts candidate timer
  assert.equal(s.accept("single:searching", 10_000), false);
  // Returning to coding must reset the candidate timer
  assert.equal(s.accept("single:coding", 10_500), true);
  // A later brief touch of searching must NOT immediately bypass SETTLE_MS
  assert.equal(s.accept("single:searching", 20_000), false);
  // Holding searching for >= 2s now settles
  assert.equal(s.accept("single:searching", 22_000), true);
  // Urgent states bypass immediately regardless of dwell/settle
  assert.equal(s.accept("orbit:claude:3:waiting", 22_100), true);
  assert.equal(s.accept("hidden", 22_200), true);
});

test("rotateLogIfNeeded copies and truncates in place only above maxBytes", () => {
  withTempHome((dir) => {
    const file = join(dir, "daemon.log");
    writeFileSync(file, "small\n");
    assert.equal(rotateLogIfNeeded(file, 100), false);
    assert.equal(readFileSync(file, "utf8"), "small\n");

    const big = "x".repeat(200);
    writeFileSync(file, big);
    assert.equal(rotateLogIfNeeded(file, 100), true);
    assert.equal(readFileSync(file, "utf8"), "");
    assert.equal(readFileSync(`${file}.1`, "utf8"), big);
  });
});

test("config validates enums, booleans, ranges, nullables, unset and reset", () => {
  withTempHome(() => {
    assert.throws(() => setConfigValue("statusDisplay", "bogus"), /must be one of/);
    assert.throws(() => setConfigValue("activityType", "99"), /must be one of/);
    assert.throws(() => setConfigValue("tokens.metric", "invalid"), /must be one of/);
    assert.throws(() => setConfigValue("tokens.source", "nope"), /must be one of/);
    assert.throws(() => setConfigValue("showProject", "tru"), /expects a boolean/);
    assert.throws(() => setConfigValue("pollMs", "100"), /at least 250/);
    assert.throws(() => setConfigValue("rotateSec", "-5"), /cannot be negative/);

    setConfigValue("showProject", "true");
    setConfigValue("t3Home", "/custom/t3");
    assert.equal(loadConfig().showProject, true);
    assert.equal(loadConfig().t3Home, "/custom/t3");

    // Resetting nullable t3Home via "null"
    setConfigValue("t3Home", "null");
    assert.equal(loadConfig().t3Home, null);

    // Invalid hand-edited enum in config.json falls back safely to default
    writeFileSync(configPath(), JSON.stringify({ activityType: 99, statusDisplay: "bogus", tokens: { metric: "nope" } }));
    const cfg = loadConfig();
    assert.equal(cfg.activityType, 0);
    assert.equal(cfg.statusDisplay, "name");
    assert.equal(cfg.tokens.metric, "total");

    // unset cleans up nested objects and reverts to default
    setConfigValue("tokens.windowDays", "7");
    assert.equal(loadConfig().tokens.windowDays, 7);
    unsetConfigValue("tokens.windowDays");
    assert.equal(loadConfig().tokens.windowDays, 30);

    setConfigValue("showModel", "false");
    resetConfig();
    assert.equal(loadConfig().showModel, true);
  });
});

test("readInstances does not leak cached instances across different T3 homes", () => {
  withTempHome((dir) => {
    const homeA = join(dir, "a-settings.json");
    const homeB = join(dir, "b-settings.json");
    writeFileSync(homeA, JSON.stringify({ providerInstances: { codex: { driver: "codex", displayName: "Home A Codex" } } }));
    assert.equal(readInstances(homeA).codex?.displayName, "Home A Codex");
    // Home B has no settings.json — must return {}, never Home A's cached value
    assert.deepEqual(readInstances(homeB), {});
  });
});

test("DynamicArt namespaces cache entries by repo and branch while honoring matching legacy entries", () => {
  withTempHome((dir) => {
    const legacyUrl = "https://raw.githubusercontent.com/alice/repo/art-cache/orbit/v2/claude__codex1-grok1.gif";
    writeFileSync(
      join(dir, "art-cache.json"),
      JSON.stringify({
        "v2/claude__codex1-grok1": { url: legacyUrl, at: 1 },
        "alice/repo@art-cache:v2/claude__codex2-grok1": {
          url: "https://raw.githubusercontent.com/alice/repo/art-cache/orbit/v2/claude__codex2-grok1.gif",
          at: 1,
        },
      }),
    );
    const quiet = { debug() {}, info() {}, warn() {} };
    const sameRepo = new DynamicArt({ repo: "alice/repo", branch: "art-cache", artVersion: "2", maxOrbiters: 16, home: dir, logger: quiet });
    assert.equal(sameRepo.peek("claude", ["codex", "grok"], 2), legacyUrl);
    assert.equal(
      sameRepo.peek("claude", ["codex", "codex", "grok"], 3),
      "https://raw.githubusercontent.com/alice/repo/art-cache/orbit/v2/claude__codex2-grok1.gif",
    );

    // Switching repo must NOT return alice/repo's cached URLs
    const otherRepo = new DynamicArt({ repo: "bob/other", branch: "art-cache", artVersion: "2", maxOrbiters: 16, home: dir, logger: quiet });
    assert.equal(otherRepo.peek("claude", ["codex", "grok"], 2), null);
    assert.equal(otherRepo.peek("claude", ["codex", "codex", "grok"], 3), null);
  });
});
