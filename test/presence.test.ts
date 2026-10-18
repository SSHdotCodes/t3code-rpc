import assert from "node:assert/strict";
import { test } from "node:test";
import { orbitKey } from "../src/art/catalog.ts";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { buildActivity } from "../src/presence/activity.ts";
import { Director } from "../src/presence/director.ts";
import { agentLabel, breakdown, characterFor, formatTokens, modelName } from "../src/presence/format.ts";
import type { ActiveThread, AgentRef, AppStatus, T3Snapshot, UsageSummary } from "../src/types.ts";

const cfg: Config = structuredClone(DEFAULT_CONFIG);
const app: AppStatus = { running: true, pid: 1, port: 3773, serverVersion: "0.0.45", dbPath: "/tmp/x" };
const claude: AgentRef = { instanceId: "claudeAgent", driver: "claudeAgent", model: "claude-opus-5-5" };
const codex: AgentRef = { instanceId: "codex", driver: "codex", model: "gpt-6.1-sol" };
const grok: AgentRef = { instanceId: "grok_grok_build", driver: "grok", model: "grok-4.7" };
const mistral: AgentRef = { instanceId: "acpRegistry_mistral_vibe", driver: "acpRegistry", model: "glm-5-3" };

const usage: UsageSummary = {
  windowDays: 30,
  since: 0,
  computedAt: 0,
  byDriver: {},
  totals: { input: 4_000_000_000, cachedInput: 3_900_000_000, cacheCreation: 0, output: 17_000_000, reasoning: 0, total: 4_017_000_000, turns: 900 },
};

const thread = (agent: AgentRef, activity: ActiveThread["activity"], children: ActiveThread["children"] = []): ActiveThread => ({
  threadId: "t",
  runStatus: "running",
  agent,
  startedAt: 1000,
  activity,
  children,
  projectName: null,
});

const snap = (threads: ActiveThread[], extra: Partial<T3Snapshot> = {}): T3Snapshot => ({
  takenAt: 0,
  threads,
  lastOutcome: null,
  lastAgent: claude,
  ...extra,
});

test("model names read nicely", () => {
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5".replace(/^/, "Claude "));
  assert.equal(modelName("gpt-6.1-sol"), "GPT-6.1 Sol");
  assert.equal(modelName("grok-4.7-build-fast"), "Grok 4.7 Build Fast");
  assert.equal(modelName("opencode-go/glm-5.2"), "GLM 5.2");
  assert.equal(modelName("default"), null);
  assert.equal(agentLabel(claude), "Claude Opus 5.5");
  assert.equal(agentLabel(codex), "GPT-6.1 Sol");
});

test("token formatting", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatTokens(4_124_480_721), "4.12B");
  assert.equal(formatTokens(16_800_000), "16.8M");
});

test("logos follow the harness, then ACP hints, then the model", () => {
  assert.equal(characterFor(claude), "claude");
  assert.equal(characterFor(codex), "codex");
  assert.equal(characterFor(grok), "grok");
  assert.equal(characterFor(mistral), "mistral");
  assert.equal(characterFor({ instanceId: "muse", driver: "muse", model: "muse-spark-1.3" }), "muse");
  assert.equal(characterFor({ instanceId: "x", driver: "acpRegistry", model: "claude-sonnet-5" }), "claude");
  assert.equal(characterFor({ instanceId: "x", driver: "acpRegistry", model: "qwen3" }), "generic");
  assert.equal(characterFor(null), "t3");
});

test("breakdown groups providers", () => {
  assert.equal(breakdown([codex, codex, grok, codex, claude]), "3 Codex · 1 Claude · 1 Grok");
});

test("single agent shows its activity", () => {
  const d = new Director().decide({ cfg, app, snapshot: snap([thread(claude, "editing")]), usage, now: 5000 })!;
  assert.deepEqual(d.art, { kind: "activity", scene: "coding", character: "claude" });
  assert.equal(d.details, "⌨️ Editing code");
  assert.equal(d.stateLines[0], "Claude Opus 5.5");
  assert.match(d.stateLines[1]!, /4\.02B tokens · last 30 days/);
  assert.equal(d.startedAt, 1000);
});

test("orchestration counts live subagents and keeps the conductor", () => {
  const parent = thread(claude, "tool", [
    { key: "a", origin: "app_owned", agent: codex, state: "executing" },
    { key: "b", origin: "app_owned", agent: codex, state: "waiting" },
    { key: "c", origin: "app_owned", agent: grok, state: "executing" },
    { key: "d", origin: "app_owned", agent: codex, state: "outstanding" },
  ]);
  const d = new Director().decide({ cfg, app, snapshot: snap([parent]), usage })!;
  assert.equal(d.art.kind, "orbit");
  if (d.art.kind !== "orbit") return;
  assert.equal(d.art.conductor, "claude");
  assert.equal(d.art.count, 3);
  assert.deepEqual(d.art.orbiters.sort(), ["codex", "codex", "grok"]);
  assert.equal(d.details, "🪄 Orchestrating 3 agents");
  assert.equal(d.stateLines[0], "Claude Opus 5.5 → 2 Codex · 1 Grok");
});

test("other threads don't inflate the conductor's subagent count", () => {
  const parent = thread(claude, "tool", [
    { key: "a", origin: "app_owned", agent: codex, state: "executing" },
    { key: "b", origin: "app_owned", agent: grok, state: "executing" },
  ]);
  const d = new Director().decide({ cfg, app, snapshot: snap([parent, thread(codex, "editing")]), usage })!;
  assert.equal(d.art.kind === "orbit" && d.art.count, 2);
  assert.equal(d.details, "🪄 Orchestrating 2 agents");
  assert.equal(d.stateLines[0], "Claude Opus 5.5 → 1 Codex · 1 Grok · +1 more agent");
});

test("parallel threads without a conductor are juggled by T3", () => {
  const d = new Director().decide({ cfg, app, snapshot: snap([thread(claude, "thinking"), thread(codex, "command")]), usage })!;
  assert.equal(d.art.kind, "orbit");
  if (d.art.kind === "orbit") assert.equal(d.art.conductor, "t3");
  assert.equal(d.details, "🪄 Running 2 agents at once");
});

test("idle, done and error", () => {
  const now = 1_000_000;
  const idle = new Director().decide({ cfg, app, snapshot: snap([]), usage, now })!;
  assert.equal(idle.mood, "idle");
  const done = new Director().decide({ cfg, app, snapshot: snap([], { lastOutcome: { status: "completed", at: now - 1000, agent: codex } }), usage, now })!;
  assert.equal(done.mood, "done");
  assert.deepEqual(done.art, { kind: "activity", scene: "done", character: "codex" });
  const stale = new Director().decide({ cfg, app, snapshot: snap([], { lastOutcome: { status: "failed", at: now - 10 * 60_000, agent: codex } }), usage, now })!;
  assert.equal(stale.mood, "idle");
  assert.equal(new Director().decide({ cfg, app: { ...app, running: false }, snapshot: snap([]), usage, now }), null);
});

test("privacy: nothing but generic text and agent labels reaches Discord", () => {
  // Even if a thread title sneaks into an object, the director never reads it.
  const sneaky = { ...thread(claude, "thinking"), title: "SECRET CHAT TITLE", projectName: "secret-repo" } as ActiveThread;
  const d = new Director().decide({ cfg, app, snapshot: snap([sneaky]), usage })!;
  const payload = JSON.stringify(buildActivity(cfg, d, null));
  assert.doesNotMatch(payload, /SECRET|secret-repo/);
  const withProject = { ...cfg, showProject: true };
  const d2 = new Director().decide({ cfg: withProject, app, snapshot: snap([sneaky]), usage })!;
  assert.match(JSON.stringify(buildActivity(withProject, d2, null, 0)), /secret-repo/);
  assert.doesNotMatch(JSON.stringify(buildActivity(withProject, d2, null)), /SECRET CHAT TITLE/);
});

test("activity payload uses versioned art URLs and buttons", () => {
  const d = new Director().decide({ cfg, app, snapshot: snap([thread(codex, "web")]), usage })!;
  const a = buildActivity(cfg, d, null, 0);
  assert.equal(a.assets?.large_image, `${cfg.art.baseUrl}/web/codex.gif?v=${cfg.art.version}`);
  assert.equal(a.assets?.small_image, `${cfg.art.baseUrl}/badges/codex.png?v=${cfg.art.version}`);
  assert.equal(a.buttons?.length, 2);
  assert.equal(a.name, "T3 Code");
});

test("orbit keys are order independent", () => {
  assert.equal(orbitKey("claude", ["grok", "codex", "codex"], 3), orbitKey("claude", ["codex", "grok", "codex"], 3));
  assert.equal(orbitKey("claude", ["codex", "codex"], 14), "claude__codex2-of14");
});
