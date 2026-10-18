import { readFileSync, statSync } from "node:fs";
import { isBusy, T3Database } from "./db.js";
const activeStatuses = "('preparing','starting','running','waiting')";
const drivers = ["codex", "claudeAgent", "cursor", "grok", "opencode", "acpRegistry", "pi", "muse", "antigravity", "gemini"];
const settingsCache = new Map();
/** Only providerInstances[id].driver is retained; labels/config/env never leave this function. */
export function driverResolver(settingsPath) {
    let configured = new Map();
    try {
        const info = statSync(settingsPath);
        const identity = `${info.ino}:${info.mtimeMs}:${info.size}`;
        let cached = settingsCache.get(settingsPath);
        if (cached?.identity !== identity) {
            const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
            const mapping = new Map();
            for (const [id, value] of Object.entries(settings?.providerInstances ?? {})) {
                const driver = value?.driver;
                if (typeof driver === "string" && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(driver))
                    mapping.set(id, driver);
            }
            cached = { identity, drivers: mapping };
            settingsCache.set(settingsPath, cached);
        }
        configured = cached.drivers;
    }
    catch {
        settingsCache.delete(settingsPath);
    }
    return (instance) => instance === null ? null : configured.get(instance)
        ?? drivers.find((driver) => instance.startsWith(driver)) ?? null;
}
const agentColumns = `COALESCE(a.provider_instance_id, r.provider_instance_id, r.provider) AS provider_instance_id,
  COALESCE(pt.driver, ps.driver) AS driver,
  json_extract(r.payload_json, '$.modelSelection.model') AS model`;
const agentJoins = `LEFT JOIN orchestration_v2_projection_run_attempts a
    ON a.attempt_id = json_extract(r.payload_json, '$.activeAttemptId')
  LEFT JOIN orchestration_v2_projection_provider_threads pt
    ON pt.provider_thread_id = COALESCE(a.provider_thread_id, r.provider_thread_id)
  LEFT JOIN orchestration_v2_projection_provider_sessions ps
    ON ps.provider_session_id = pt.provider_session_id`;
const lineageColumns = `json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
  json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship`;
const runColumns = `r.thread_id, r.run_id, r.ordinal AS run_ordinal, r.status AS run_status,
  r.completed_at, ${agentColumns},
  COALESCE(json_extract(r.payload_json, '$.workStartedAt'),
    json_extract(r.payload_json, '$.startedAt'), r.requested_at) AS work_started_at`;
function projectColumns(enabled) {
    if (!enabled)
        return "NULL AS project_name";
    // Strip the directory in SQL: even the opt-in result contains only a basename.
    const root = "rtrim(replace(p.workspace_root, char(92), '/'), '/')";
    return `substr(${root}, length(rtrim(${root}, replace(${root}, '/', ''))) + 1) AS project_name`;
}
function projectJoin(enabled) {
    return enabled ? "LEFT JOIN projection_projects p ON p.project_id = t.project_id" : "";
}
// Match the recovery index's predicate exactly before excluding queued runs.
function activeQuery(projectNames) {
    return `SELECT ${runColumns}, ${lineageColumns}, ${projectColumns(projectNames)}
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
    ${agentJoins} ${projectJoin(projectNames)}
    WHERE r.status IN ('queued','preparing','starting','running','waiting') AND r.status <> 'queued'
      AND t.deleted_at IS NULL AND t.archived_at IS NULL
    ORDER BY r.requested_at DESC, r.run_id DESC`;
}
const backgroundParentsQuery = `SELECT DISTINCT n.thread_id
  FROM orchestration_v2_projection_nodes n
  JOIN orchestration_v2_projection_threads t ON t.thread_id = n.thread_id
  WHERE n.status IN ('pending','starting','running','waiting') AND n.kind = 'subagent'
    AND t.deleted_at IS NULL AND t.archived_at IS NULL`;
const requestsQuery = `SELECT q.kind, n.run_id AS request_run_id, n.status AS node_status
  FROM orchestration_v2_projection_runtime_requests q
  LEFT JOIN orchestration_v2_projection_nodes n ON n.node_id = q.node_id
  WHERE q.thread_id = ? AND q.status = 'pending'`;
const itemsQuery = `SELECT i.type, json_extract(i.payload_json, '$.toolName') AS tool_name,
  json_extract(i.payload_json, '$.requestKind') AS request_kind,
  json_extract(i.payload_json, '$.streaming') AS streaming, n.status AS node_status
  FROM orchestration_v2_projection_turn_items i
  LEFT JOIN orchestration_v2_projection_nodes n ON n.node_id = i.node_id
  WHERE i.run_id = ? AND i.thread_id = ? AND i.status IN ('pending','running','waiting')`;
const childrenQuery = `SELECT s.subagent_id, s.origin, s.status AS task_status,
  s.child_thread_id, COALESCE(cr.provider_thread_id, s.provider_thread_id) AS provider_thread_id,
  cr.run_id AS child_active_run_id, cr.status AS child_run_status,
  COALESCE(cr.provider_instance_id, s.provider_instance_id, s.provider) AS provider_instance_id,
  COALESCE(pt.driver, s.driver) AS driver,
  COALESCE(json_extract(cr.payload_json, '$.modelSelection.model'),
    json_extract(s.payload_json, '$.modelSelection.model'), json_extract(s.payload_json, '$.model')) AS model,
  s.updated_at
  FROM orchestration_v2_projection_subagents s
  LEFT JOIN orchestration_v2_projection_runs cr ON cr.run_id = (
    SELECT r.run_id FROM orchestration_v2_projection_runs r
    WHERE r.thread_id = s.child_thread_id AND r.status IN ${activeStatuses}
    ORDER BY r.ordinal DESC LIMIT 1)
  LEFT JOIN orchestration_v2_projection_provider_threads pt
    ON pt.provider_thread_id = COALESCE(cr.provider_thread_id, s.provider_thread_id)
  WHERE s.thread_id = ? AND (s.status IN ('pending','running','waiting') OR cr.run_id IS NOT NULL)
  ORDER BY s.started_at DESC, s.subagent_id DESC`;
const workflowQuery = `SELECT s.subagent_id AS coordinator_id,
  json_extract(a.value, '$.index') AS agent_index,
  json_extract(a.value, '$.childThreadId') AS child_thread_id,
  json_extract(a.value, '$.state') AS state,
  COALESCE(json_extract(a.value, '$.model'), json_extract(s.payload_json, '$.model')) AS model,
  s.provider_instance_id, s.driver, s.updated_at
  FROM orchestration_v2_projection_subagents s, json_each(s.payload_json, '$.workflow.agents') a
  WHERE s.thread_id = ? AND s.origin = 'provider_native' AND s.status IN ('pending','running','waiting')
    AND json_extract(a.value, '$.state') IN ('queued','running')`;
const reverseParentsQuery = `SELECT DISTINCT thread_id FROM orchestration_v2_projection_subagents WHERE child_thread_id = ?`;
const recentRunsQuery = `SELECT ${runColumns}, ${lineageColumns}, NULL AS project_name
  FROM orchestration_v2_projection_runs r
  LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
  ${agentJoins} ORDER BY r.rowid DESC LIMIT ?`;
const recentTerminalRunsQuery = recentRunsQuery.replace(" ORDER BY r.rowid", " WHERE r.status IN ('completed','failed','interrupted','cancelled') ORDER BY r.rowid");
const finalRunQuery = `SELECT ${runColumns}, ${lineageColumns}, NULL AS project_name
  FROM orchestration_v2_projection_runs r
  LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
  ${agentJoins} WHERE r.run_id = ?`;
function epoch(value) {
    const parsed = value === null ? NaN : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function toolActivity(name) {
    const tool = (name ?? "").toLowerCase();
    if (/edit|write|patch|apply|str_replace|multiedit|notebook/.test(tool))
        return "editing";
    if (/bash|shell|exec|command|terminal|run/.test(tool))
        return "command";
    if (/webfetch|web_fetch|websearch|web_search|browse|fetch|url/.test(tool))
        return "web";
    if (/read|grep|glob|search|find|list|ls|view|open/.test(tool))
        return "searching";
    return "tool";
}
const approvals = new Set(["command", "file-read", "file-change", "permission", "mcp-elicitation"]);
const priorities = ["approval", "question", "editing", "command", "web", "searching", "tool", "responding", "thinking"];
function activity(row, requests, items) {
    const seen = new Set();
    for (const request of requests) {
        if (request.request_run_id !== null && row.run_id !== null && request.request_run_id !== row.run_id)
            continue;
        if (approvals.has(request.kind))
            seen.add("approval");
        if (request.kind === "user_input" && (request.node_status === "waiting" || row.run_status === "waiting"))
            seen.add("question");
    }
    for (const item of items) {
        switch (item.type) {
            case "approval_request":
                if (approvals.has(item.request_kind ?? ""))
                    seen.add("approval");
                break;
            case "user_input_request":
                if (item.node_status === "waiting" || row.run_status === "waiting")
                    seen.add("question");
                break;
            case "file_change":
                seen.add("editing");
                break;
            case "command_execution":
                seen.add("command");
                break;
            case "web_search":
                seen.add("web");
                break;
            case "file_search":
                seen.add("searching");
                break;
            case "dynamic_tool":
                seen.add(toolActivity(item.tool_name));
                break;
            case "assistant_message":
                if (item.streaming)
                    seen.add("responding");
                break;
            case "reasoning":
                seen.add("thinking");
                break;
        }
    }
    return priorities.find((kind) => seen.has(kind)) ?? (["preparing", "starting"].includes(row.run_status) ? "starting" : "working");
}
export class StateReader {
    db;
    includeProjectNames;
    outstandingMaxAgeMs;
    #previousRuns = new Map();
    #lastOutcome = null;
    #lastAgent = null;
    #lastAgentAt = -Infinity;
    #initialized = false;
    #generation = -1;
    #lastSnapshot = null;
    constructor(db, opts = {}) {
        this.db = db;
        this.includeProjectNames = opts.includeProjectNames ?? false;
        this.outstandingMaxAgeMs = opts.outstandingMaxAgeMs ?? 6 * 60 * 60 * 1000;
    }
    read(now = Date.now()) {
        const resolveDriver = driverResolver(this.db.settingsPath);
        const agent = (row) => ({ instanceId: row.provider_instance_id,
            driver: row.driver ?? resolveDriver(row.provider_instance_id), model: row.model });
        try {
            const generation = this.db.generation;
            if (generation !== this.#generation) {
                this.#previousRuns.clear();
                this.#initialized = false;
                this.#lastOutcome = null;
                this.#lastAgent = null;
                this.#lastAgentAt = -Infinity;
                this.#generation = generation;
            }
            if (!this.db.hasV2)
                return { takenAt: now, threads: [], lastOutcome: null, lastAgent: null };
            const snapshot = this.db.transaction(() => {
                const activeRuns = this.db.all(activeQuery(this.includeProjectNames));
                const candidates = new Map();
                for (const row of activeRuns) {
                    const current = candidates.get(row.thread_id);
                    if (!current || row.run_ordinal > current.run_ordinal)
                        candidates.set(row.thread_id, row);
                }
                for (const { thread_id } of this.db.all(backgroundParentsQuery)) {
                    if (candidates.has(thread_id))
                        continue;
                    const row = this.db.get(`SELECT t.thread_id, r.run_id, r.ordinal AS run_ordinal,
            r.status AS run_status, r.completed_at, ${agentColumns},
            NULL AS work_started_at, ${lineageColumns}, ${projectColumns(this.includeProjectNames)}
            FROM orchestration_v2_projection_threads t
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
              SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = t.thread_id ORDER BY ordinal DESC LIMIT 1)
            ${agentJoins} ${projectJoin(this.includeProjectNames)} WHERE t.thread_id = ?`, thread_id);
                    if (row)
                        candidates.set(thread_id, { ...row, run_id: null, run_status: "waiting" });
                }
                const requests = new Map();
                const pending = (id) => {
                    if (!requests.has(id))
                        requests.set(id, this.db.all(requestsQuery, id));
                    return requests.get(id);
                };
                const lineage = new Map();
                for (const row of candidates.values()) {
                    if (row.relationship === "subagent" && row.parent_thread_id) {
                        const children = lineage.get(row.parent_thread_id) ?? [];
                        children.push(row);
                        lineage.set(row.parent_thread_id, children);
                    }
                }
                const childrenCache = new Map();
                const fresh = (timestamp) => {
                    const at = epoch(timestamp);
                    return at !== null && now - at <= this.outstandingMaxAgeMs;
                };
                const childState = (id, runStatus, taskStatus, native) => {
                    if (runStatus === "waiting" || (id && pending(id).length > 0))
                        return "waiting";
                    if (["preparing", "starting", "running"].includes(runStatus ?? "") || (native && taskStatus === "running"))
                        return "executing";
                    return "outstanding";
                };
                const directChildren = (id) => {
                    if (childrenCache.has(id))
                        return childrenCache.get(id);
                    const workflows = this.db.all(workflowQuery, id);
                    const coordinators = new Set(workflows.map((row) => row.coordinator_id));
                    const result = [];
                    for (const row of this.db.all(childrenQuery, id)) {
                        if (coordinators.has(row.subagent_id))
                            continue;
                        const state = childState(row.child_thread_id, row.child_run_status, row.task_status, row.origin === "provider_native");
                        if (state === "outstanding" && !fresh(row.updated_at))
                            continue;
                        result.push({ key: row.child_thread_id ?? row.provider_thread_id ?? row.subagent_id,
                            threadId: row.child_thread_id, origin: row.origin === "provider_native" ? "provider_native" : "app_owned",
                            agent: candidates.has(row.child_thread_id ?? "") ? agent(candidates.get(row.child_thread_id)) : agent(row), state,
                            aliases: [row.child_thread_id && `t:${row.child_thread_id}`, row.provider_thread_id && `p:${row.provider_thread_id}`, `s:${row.subagent_id}`].filter((v) => !!v) });
                    }
                    for (const row of workflows) {
                        const active = candidates.get(row.child_thread_id ?? "");
                        const state = active ? childState(row.child_thread_id, active.run_status, "running", false)
                            : row.child_thread_id && pending(row.child_thread_id).length ? "waiting"
                                : row.state === "running" ? "executing" : "outstanding";
                        if (state === "outstanding" && !fresh(row.updated_at))
                            continue;
                        result.push({ key: row.child_thread_id ?? `${row.coordinator_id}:${row.agent_index}`,
                            threadId: row.child_thread_id, origin: "provider_native", agent: agent(active ?? row), state,
                            aliases: row.child_thread_id ? [`t:${row.child_thread_id}`] : [`w:${row.coordinator_id}:${row.agent_index}`] });
                    }
                    // A child can be resumed after its original task ticket was completed.
                    for (const row of lineage.get(id) ?? []) {
                        result.push({ key: row.thread_id, threadId: row.thread_id, origin: "app_owned", agent: agent(row),
                            state: childState(row.thread_id, row.run_status, "running", false), aliases: [`t:${row.thread_id}`] });
                    }
                    childrenCache.set(id, result);
                    return result;
                };
                const descendants = (root) => {
                    const visited = new Set([root]);
                    const queue = [root];
                    const unique = new Set();
                    const aliases = new Map();
                    const rank = { outstanding: 0, executing: 1, waiting: 2 };
                    for (let index = 0; index < queue.length; index++) {
                        for (const entry of directChildren(queue[index])) {
                            if (entry.threadId === root)
                                continue;
                            if (entry.threadId && !visited.has(entry.threadId)) {
                                visited.add(entry.threadId);
                                queue.push(entry.threadId);
                            }
                            // Merge aliases as well as keys: a native worker may later acquire an app thread.
                            const matches = new Set(entry.aliases.map((alias) => aliases.get(alias)).filter((v) => !!v));
                            const child = { ...entry, aliases: [...entry.aliases] };
                            for (const old of matches) {
                                child.aliases.push(...old.aliases);
                                if (rank[old.state] > rank[child.state])
                                    child.state = old.state;
                                if (!child.threadId && old.threadId) {
                                    child.threadId = old.threadId;
                                    child.key = old.key;
                                    child.agent = old.agent;
                                }
                                unique.delete(old);
                            }
                            unique.add(child);
                            for (const alias of child.aliases)
                                aliases.set(alias, child);
                        }
                    }
                    return [...unique];
                };
                const allChildren = new Map();
                for (const id of candidates.keys())
                    allChildren.set(id, descendants(id));
                // Live-node candidates with only stale tickets are no longer active parents.
                for (const [id, row] of candidates) {
                    if (row.run_id === null && !allChildren.get(id)?.length) {
                        candidates.delete(id);
                        allChildren.delete(id);
                    }
                }
                const parents = new Map();
                const parentsOf = (id, row) => {
                    if (!parents.has(id)) {
                        const set = new Set(this.db.all(reverseParentsQuery, id).map((r) => r.thread_id));
                        if (row?.relationship === "subagent" && row.parent_thread_id)
                            set.add(row.parent_thread_id);
                        parents.set(id, set);
                    }
                    return parents.get(id);
                };
                for (const [id, children] of allChildren) {
                    for (const child of children)
                        if (child.threadId)
                            parentsOf(child.threadId, candidates.get(child.threadId)).add(id);
                }
                const folded = new Set();
                // Keep at least one root for malformed cyclic delegation graphs.
                for (const [id, row] of candidates) {
                    if ([...parentsOf(id, row)].some((parent) => parent !== id && candidates.has(parent) && !folded.has(parent)))
                        folded.add(id);
                }
                const threads = [];
                for (const [id, row] of candidates) {
                    if (folded.has(id))
                        continue;
                    const items = row.run_id ? this.db.all(itemsQuery, row.run_id, id) : [];
                    threads.push({ threadId: id, runStatus: row.run_status, agent: agent(row),
                        startedAt: epoch(row.work_started_at), activity: activity(row, pending(id), items),
                        children: (allChildren.get(id) ?? []).map(({ key, origin, agent, state }) => ({ key, origin, agent, state })),
                        projectName: this.includeProjectNames ? row.project_name : null });
                }
                const delegatedWhileParentActive = (row) => [...parentsOf(row.thread_id, row)]
                    .some((id) => id !== row.thread_id && candidates.has(id));
                let lastOutcome = this.#lastOutcome;
                const considerOutcome = (row) => {
                    if (!["completed", "failed", "interrupted", "cancelled"].includes(row.run_status) || delegatedWhileParentActive(row))
                        return;
                    const at = epoch(row.completed_at);
                    if (at !== null && (!lastOutcome || at >= lastOutcome.at))
                        lastOutcome = {
                            status: row.run_status, at, agent: agent(row),
                        };
                };
                const currentRuns = new Map(activeRuns.map((row) => [row.run_id, row]));
                if (!this.#initialized) {
                    for (const row of this.db.all(recentTerminalRunsQuery, 20))
                        considerOutcome(row);
                }
                else {
                    for (const id of this.#previousRuns.keys()) {
                        if (!currentRuns.has(id)) {
                            const row = this.db.get(finalRunQuery, id);
                            if (row)
                                considerOutcome(row);
                        }
                    }
                }
                let lastAgent = this.#lastAgent;
                if (now - this.#lastAgentAt >= 30_000) {
                    const latest = this.db.get(recentRunsQuery, 1);
                    lastAgent = latest ? agent(latest) : null;
                }
                return { snapshot: { takenAt: now, threads, lastOutcome, lastAgent }, currentRuns };
            });
            // Commit reader caches only after the entire read transaction succeeds.
            this.#previousRuns = snapshot.currentRuns;
            this.#lastOutcome = snapshot.snapshot.lastOutcome;
            this.#lastAgent = snapshot.snapshot.lastAgent;
            if (now - this.#lastAgentAt >= 30_000)
                this.#lastAgentAt = now;
            this.#initialized = true;
            this.#lastSnapshot = snapshot.snapshot;
            return snapshot.snapshot;
        }
        catch (error) {
            if (isBusy(error) && this.#lastSnapshot)
                return { ...this.#lastSnapshot, takenAt: now };
            return { takenAt: now, threads: [], lastOutcome: this.#lastOutcome, lastAgent: this.#lastAgent };
        }
    }
}
