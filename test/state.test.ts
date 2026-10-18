import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SQLInputValue } from "node:sqlite";
import { T3Database } from "../src/t3/db.ts";
import { detectApp } from "../src/t3/detect.ts";
import { resolveT3Paths } from "../src/t3/paths.ts";
import { driverResolver, StateReader } from "../src/t3/state.ts";

const { DatabaseSync } = await import("node:sqlite");
const schema = readFileSync(new URL(`./fixtures/${process.env.T3RPC_SCHEMA ?? "schema.sql"}`, import.meta.url), "utf8");
const now = Date.parse("2026-10-17T23:00:00.000Z");
const iso = (at = now) => new Date(at).toISOString();
const secret = "PRIVATE CHAT TITLE / prompt / /private/worktree/file.txt";

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "t3-rpc-state-"));
  const path = join(dir, "statev2.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec(schema);
  const db = new T3Database(path);
  t.after(() => { db.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); });
  function insert(suffix: string, values: Record<string, string | number | null>) {
    const table = suffix === "projects" ? "projection_projects" : `orchestration_v2_projection_${suffix}`;
    const fields = writer.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null; type: string }[];
    const row: Record<string, string | number | null> = {};
    for (const field of fields) if (field.notnull && field.dflt_value === null) {
      row[field.name] = field.type === "INTEGER" ? 0 : field.name === "payload_json" ? "{}" : "fixture";
    }
    Object.assign(row, values);
    writer.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  }
  insert("projects", { project_id: "project", title: secret, workspace_root: "/private/work/project-code", scripts_json: "[]", created_at: iso(), updated_at: iso() });
  function thread(id: string, parent: string | null = null, relationship = "subagent") {
    insert("threads", { thread_id: id, project_id: "project", title: secret, default_provider: "future-default",
      created_at: iso(), updated_at: iso(), payload_json: JSON.stringify({ title: secret, worktreePath: secret,
        lineage: { parentThreadId: parent, relationshipToParent: parent ? relationship : null } }) });
  }
  function run(id: string, threadId: string, opts: { status?: string; instance?: string; driver?: string | null; model?: string; ordinal?: number; at?: number; completed?: number } = {}) {
    const instance = opts.instance ?? "claudeAgent";
    insert("provider_threads", { provider_thread_id: `pt:${id}`, provider: instance, provider_instance_id: instance,
      driver: opts.driver === undefined ? instance : opts.driver, status: "active", updated_at: iso() });
    insert("runs", { run_id: id, thread_id: threadId, ordinal: opts.ordinal ?? 1, provider: instance,
      provider_instance_id: instance, provider_thread_id: `pt:${id}`, status: opts.status ?? "running", requested_at: iso(opts.at),
      completed_at: opts.completed === undefined ? null : iso(opts.completed),
      payload_json: JSON.stringify({ modelSelection: { model: opts.model ?? "claude-opus-5-5" }, startedAt: iso(opts.at), prompt: secret }) });
    insert("nodes", { node_id: `n:${id}`, thread_id: threadId, run_id: id, root_node_id: `n:${id}`, kind: "root_turn",
      status: opts.status === "waiting" ? "waiting" : "running" });
  }
  function subagent(id: string, parent: string, child: string | null, opts: { origin?: string; instance?: string; status?: string; at?: number; payload?: object; providerThread?: string } = {}) {
    insert("subagents", { subagent_id: id, thread_id: parent, parent_node_id: `parent:${parent}`, provider: opts.instance ?? "codex",
      provider_instance_id: opts.instance ?? "codex", driver: null, provider_thread_id: opts.providerThread ?? null, child_thread_id: child,
      origin: opts.origin ?? "app_owned", status: opts.status ?? "running", started_at: iso(opts.at), updated_at: iso(opts.at),
      payload_json: JSON.stringify({ model: "gpt-6.1-sol", prompt: secret, ...opts.payload }) });
    insert("nodes", { node_id: id, thread_id: parent, root_node_id: id, kind: "subagent", status: "running" });
  }
  function request(id: string, threadId: string, runId: string, kind: string, nodeStatus?: string) {
    if (nodeStatus) writer.prepare("UPDATE orchestration_v2_projection_nodes SET status = ? WHERE node_id = ?").run(nodeStatus, `n:${runId}`);
    insert("runtime_requests", { runtime_request_id: id, thread_id: threadId, node_id: `n:${runId}`, kind, status: "pending",
      created_at: iso(), payload_json: JSON.stringify({ prompt: secret }) });
  }
  function item(id: string, threadId: string, runId: string, type: string, payload: object = {}, status = "running", ordinal = 1) {
    insert("turn_items", { turn_item_id: id, thread_id: threadId, run_id: runId, node_id: `n:${runId}`, ordinal, type, status,
      updated_at: iso(), payload_json: JSON.stringify({ text: secret, input: secret, output: secret, ...payload }) });
  }
  return { db, writer, dir, path, insert, thread, run, subagent, request, item };
}

test("folds two Codex children and a Grok grandchild into their Claude parent; drops stale tickets", (t) => {
  const f = fixture(t);
  f.thread("parent"); f.run("parent-run", "parent");
  f.run("queued-newer", "parent", { ordinal: 2, status: "queued", instance: "wrong-provider", model: "wrong-model" });
  f.thread("child-one", "parent"); f.run("child-one-run", "child-one", { instance: "codex", model: "gpt-6.1-sol" });
  f.thread("child-two"); f.run("child-two-run", "child-two", { instance: "codex", model: "gpt-6.1-sol", status: "waiting" });
  f.thread("grandchild", "child-one"); f.run("grandchild-run", "grandchild", { instance: "grok_grok_build", driver: null, model: "grok-4.7" });
  f.subagent("one", "parent", "child-one");
  f.subagent("one-duplicate", "parent", "child-one");
  f.subagent("two", "parent", "child-two");
  f.subagent("grand", "child-one", "grandchild", { instance: "grok_grok_build" });
  f.subagent("stale", "parent", "inactive", { at: now - 49 * 60 * 60 * 1000 });
  const snapshot = new StateReader(f.db).read(now);
  assert.equal(snapshot.threads.length, 1);
  const parent = snapshot.threads[0]!;
  assert.equal(parent.threadId, "parent");
  assert.equal(parent.agent.model, "claude-opus-5-5");
  assert.equal(parent.projectName, null);
  assert.equal(parent.children.length, 3);
  assert.deepEqual(Object.fromEntries(parent.children.map((c) => [c.key, c.state])), { "child-one": "executing", "child-two": "waiting", grandchild: "executing" });
  assert.equal(parent.children.find((c) => c.key === "grandchild")?.agent.driver, "grok");
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.ok(!JSON.stringify(snapshot).includes("/private/"));
});

test("does not select private columns; project basename is strictly opt-in", (t) => {
  const f = fixture(t);
  f.thread("parent"); f.run("r", "parent");
  const original = f.db.all.bind(f.db);
  const queries: string[] = [];
  f.db.all = ((sql: string, ...params: SQLInputValue[]) => {
    queries.push(sql);
    return original(sql, ...params);
  }) as T3Database["all"];
  assert.equal(new StateReader(f.db).read(now).threads[0]?.projectName, null);
  assert.ok(!queries.some((sql) => /workspace_root|projection_projects|\.title\b|SELECT\s+\*|SELECT\s+\w+\.\*/i.test(sql)));
  queries.length = 0;
  assert.equal(new StateReader(f.db, { includeProjectNames: true }).read(now).threads[0]?.projectName, "project-code");
  const selected = original<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'");
  assert.ok(selected.length > 0);
  f.writer.prepare("UPDATE projection_projects SET workspace_root = ?").run("C:\\private\\folder-name\\");
  assert.equal(new StateReader(f.db, { includeProjectNames: true }).read(now).threads[0]?.projectName, "folder-name");
});

test("approval requests outrank editing; asynchronous questions only win while blocked", (t) => {
  const f = fixture(t);
  f.thread("approval"); f.run("approval-run", "approval");
  f.item("edit", "approval", "approval-run", "dynamic_tool", { toolName: "mcp__editor__str_replace" });
  f.request("ask", "approval", "approval-run", "user_input");
  const reader = new StateReader(f.db);
  assert.equal(reader.read(now).threads[0]?.activity, "editing");
  f.writer.prepare("UPDATE orchestration_v2_projection_nodes SET status = 'waiting' WHERE node_id = 'n:approval-run'").run();
  assert.equal(reader.read(now + 1).threads[0]?.activity, "question");
  f.request("approve", "approval", "approval-run", "permission");
  assert.equal(reader.read(now + 2).threads[0]?.activity, "approval");
});

test("classifies tool names, streaming, unknown types, and setup without leaking raw tool names", (t) => {
  const f = fixture(t);
  const cases = [
    ["edit", "dynamic_tool", { toolName: "MultiEdit" }, "editing"],
    ["command", "dynamic_tool", { toolName: "Bash" }, "command"],
    ["web", "dynamic_tool", { toolName: "web_fetch" }, "web"],
    ["search", "dynamic_tool", { toolName: "Grep" }, "searching"],
    ["delegate", "dynamic_tool", { toolName: "mcp__t3-code__delegate_task" }, "tool"],
    ["respond", "assistant_message", { streaming: true }, "responding"],
    ["think", "reasoning", {}, "thinking"],
    ["unknown", "future_activity", {}, "working"],
  ] as const;
  for (const [id, type, payload] of cases) { f.thread(id); f.run(id, id); f.item(id, id, id, type, payload); }
  f.thread("setup"); f.run("setup", "setup", { status: "preparing", driver: null, instance: "future-provider" });
  const snapshot = new StateReader(f.db).read(now);
  for (const [id, , , expected] of cases) assert.equal(snapshot.threads.find((r) => r.threadId === id)?.activity, expected);
  assert.equal(snapshot.threads.find((r) => r.threadId === "setup")?.activity, "starting");
  assert.equal(snapshot.threads.find((r) => r.threadId === "setup")?.agent.driver, null);
  assert.ok(!JSON.stringify(snapshot).includes("toolName"));
});

test("ignores completed items and pending requests belonging to an old run", (t) => {
  const f = fixture(t);
  f.thread("thread"); f.run("old", "thread", { status: "completed", completed: now - 1000 });
  f.run("new", "thread", { ordinal: 2 });
  f.request("old-approval", "thread", "old", "command", "waiting");
  f.item("completed-edit", "thread", "new", "file_change", {}, "completed");
  f.item("thinking", "thread", "new", "reasoning", {}, "running", 2);
  assert.equal(new StateReader(f.db).read(now).threads[0]?.activity, "thinking");
});

test("keeps a resumed lineage child top-level when its parent is inactive", (t) => {
  const f = fixture(t);
  f.thread("inactive-parent"); f.run("old", "inactive-parent", { status: "completed", completed: now - 10_000 });
  f.thread("resumed", "inactive-parent"); f.run("resumed", "resumed");
  assert.deepEqual(new StateReader(f.db).read(now).threads.map((r) => r.threadId), ["resumed"]);
});

test("includes parents whose own run ended, with executing native workers and outstanding tickets", (t) => {
  const f = fixture(t);
  f.thread("parent"); f.run("done", "parent", { status: "completed", completed: now - 2000 });
  f.subagent("native", "parent", null, { origin: "provider_native" });
  f.subagent("outstanding", "parent", null, { status: "pending" });
  f.subagent("stale", "parent", null, { status: "pending", at: now - 1000 });
  const snapshot = new StateReader(f.db, { outstandingMaxAgeMs: 500 }).read(now);
  assert.equal(snapshot.threads[0]?.runStatus, "waiting");
  assert.deepEqual(Object.fromEntries(snapshot.threads[0]!.children.map((c) => [c.key, c.state])), { outstanding: "outstanding", native: "executing" });
});

test("expands native workflows without counting the coordinator or duplicate child twice", (t) => {
  const f = fixture(t);
  f.thread("parent"); f.run("parent", "parent");
  f.thread("child", "parent"); f.run("child", "child", { instance: "codex", model: "gpt-6.1-sol" });
  f.subagent("coordinator", "parent", null, { origin: "provider_native", payload: { workflow: { agents: [
    { index: 0, childThreadId: "child", state: "running", model: "wrong-native-model" },
    { index: 1, state: "queued", model: "native-model" },
    { index: 2, state: "completed", model: "ignored" },
  ] } } });
  f.subagent("duplicate-child", "parent", "child");
  const children = new StateReader(f.db).read(now).threads[0]!.children;
  assert.equal(children.length, 2);
  assert.equal(children.find((c) => c.key === "child")?.agent.model, "gpt-6.1-sol");
  assert.equal(children.find((c) => c.key === "coordinator:1")?.state, "outstanding");
});

test("updates lastOutcome on a terminal transition, suppressing a child while its parent works", (t) => {
  const f = fixture(t);
  f.thread("parent"); f.run("parent", "parent");
  f.thread("child", "parent"); f.run("child", "child", { instance: "codex" });
  f.subagent("task", "parent", "child");
  const reader = new StateReader(f.db);
  assert.equal(reader.read(now).lastOutcome, null);
  f.writer.prepare("UPDATE orchestration_v2_projection_runs SET status = 'completed', completed_at = ? WHERE run_id = 'child'").run(iso(now + 10));
  f.writer.prepare("UPDATE orchestration_v2_projection_subagents SET status = 'completed' WHERE subagent_id = 'task'").run();
  f.writer.prepare("UPDATE orchestration_v2_projection_nodes SET status = 'completed' WHERE node_id = 'task'").run();
  assert.equal(reader.read(now + 11).lastOutcome, null);
  f.writer.prepare("UPDATE orchestration_v2_projection_runs SET status = 'failed', completed_at = ? WHERE run_id = 'parent'").run(iso(now + 20));
  const done = reader.read(now + 21);
  assert.equal(done.threads.length, 0);
  assert.deepEqual(done.lastOutcome, { status: "failed", at: now + 20, agent: { instanceId: "claudeAgent", driver: "claudeAgent", model: "claude-opus-5-5" } });
});

test("initial outcome uses completion time; lastAgent refreshes at most every 30 seconds", (t) => {
  const f = fixture(t);
  f.thread("first"); f.run("first", "first", { status: "completed", completed: now - 1000 });
  f.thread("second"); f.run("second", "second", { status: "interrupted", completed: now - 2000, instance: "codex" });
  const reader = new StateReader(f.db);
  assert.equal(reader.read(now).lastOutcome?.status, "completed");
  assert.equal(reader.read(now).lastAgent?.driver, "codex");
  f.thread("third"); f.run("third", "third", { instance: "grok_grok_build", driver: null });
  assert.equal(reader.read(now + 29_999).lastAgent?.driver, "codex");
  assert.equal(reader.read(now + 30_000).lastAgent?.driver, "grok");
});

test("settings map only supplies missing drivers, and follows mtime changes", (t) => {
  const f = fixture(t);
  f.thread("custom"); f.run("custom", "custom", { instance: "custom_instance", driver: null });
  f.thread("explicit"); f.run("explicit", "explicit", { instance: "custom_instance", driver: "explicitDriver" });
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ providerInstances: { custom_instance: { driver: "grok", displayName: secret, environment: secret } } }));
  let snapshot = new StateReader(f.db).read(now);
  assert.equal(snapshot.threads.find((r) => r.threadId === "custom")?.agent.driver, "grok");
  assert.equal(snapshot.threads.find((r) => r.threadId === "explicit")?.agent.driver, "explicitDriver");
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ providerInstances: { custom_instance: { driver: "claudeAgent" } } }));
  snapshot = new StateReader(f.db).read(now + 1);
  assert.equal(snapshot.threads.find((r) => r.threadId === "custom")?.agent.driver, "claudeAgent");
  const resolve = driverResolver(join(f.dir, "missing-settings.json"));
  assert.equal(resolve("acpRegistry_mistral_vibe"), "acpRegistry");
  assert.equal(resolve("grok_grok_build"), "grok");
  assert.ok(!JSON.stringify(snapshot).includes(secret));
});

test("DB is query-only, survives busy polls, missing files, and file replacement", (t) => {
  const f = fixture(t);
  f.thread("active"); f.run("active", "active");
  assert.equal(f.db.hasV2, true);
  assert.throws(() => f.db.all("DELETE FROM orchestration_v2_projection_runs"), /readonly|read-only/i);
  const reader = new StateReader(f.db);
  assert.equal(reader.read(now).threads.length, 1);
  f.writer.exec("BEGIN EXCLUSIVE");
  try { assert.equal(reader.read(now + 1).threads.length, 1); } finally { f.writer.exec("ROLLBACK"); }
  renameSync(f.path, join(f.dir, "old.sqlite"));
  assert.equal(reader.read(now + 2).threads.length, 0);
  const replacement = new DatabaseSync(f.path);
  replacement.exec(schema);
  replacement.close();
  assert.equal(f.db.hasV2, true);
  assert.equal(reader.read(now + 3).threads.length, 0);
  assert.equal(reader.read(now + 3).lastAgent, null);
});

test("missing/legacy/corrupt DBs and absent app runtime records are harmless", async (t) => {
  const f = fixture(t);
  const missing = new T3Database(join(f.dir, "missing.sqlite"));
  t.after(() => missing.close());
  assert.equal(missing.hasV2, false);
  assert.equal(new StateReader(missing).read(now).threads.length, 0);
  assert.equal((await detectApp({ paths: { ...resolveT3Paths(), dbPath: f.path, runtimePath: join(f.dir, "missing.json") } })).running, false);
  const corruptPath = join(f.dir, "corrupt.sqlite");
  writeFileSync(corruptPath, "not sqlite");
  const corrupt = new T3Database(corruptPath);
  t.after(() => corrupt.close());
  assert.equal(new StateReader(corrupt).read(now).threads.length, 0);
  const oldPath = join(f.dir, "legacy.sqlite");
  const legacyWriter = new DatabaseSync(oldPath); legacyWriter.exec("CREATE TABLE legacy (id TEXT)"); legacyWriter.close();
  const legacy = new T3Database(oldPath); t.after(() => legacy.close());
  assert.equal(legacy.hasV2, false);
  assert.equal(new StateReader(legacy).read(now).threads.length, 0);
  const migration = new DatabaseSync(oldPath); migration.exec(schema); migration.close();
  assert.equal(legacy.hasV2, true);
});

test("detects exact live PID plus HTTP probe, with a bounded startup grace period", async (t) => {
  const f = fixture(t);
  const server = createServer((_, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const runtimePath = join(f.dir, "server-runtime.json");
  const paths = { ...resolveT3Paths(), dbPath: f.path, runtimePath };
  const record = { pid: process.pid, port, serverVersion: "test", startedAt: iso(now - 120_000) };
  writeFileSync(runtimePath, JSON.stringify(record));
  assert.equal((await detectApp({ paths, now })).running, true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal((await detectApp({ paths, now, timeoutMs: 50 })).running, false);
  writeFileSync(runtimePath, JSON.stringify({ ...record, startedAt: iso(now - 59_999) }));
  assert.equal((await detectApp({ paths, now, timeoutMs: 50 })).running, true);
  assert.equal((await detectApp({ paths, now: now + 1, timeoutMs: 50 })).running, false);
  writeFileSync(runtimePath, JSON.stringify({ ...record, pid: 2_147_483_647, startedAt: iso() }));
  assert.equal((await detectApp({ paths, now })).running, false);
});

test("resolves the upstream home override", () => {
  assert.equal(resolveT3Paths({ env: { T3CODE_HOME: " /tmp/custom-home ", T3_HOME: "/tmp/ignored" } }).dbPath, "/tmp/custom-home/userdata/statev2.sqlite");
});
