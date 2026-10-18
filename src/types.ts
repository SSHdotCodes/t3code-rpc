// Shared types between the T3 state reader, the presence model and the daemon.
//
// PRIVACY RULE: nothing in here may ever carry a thread/chat title, message
// text, prompts, tool input/output, file paths or diffs. The reader never
// selects those columns. Only statuses, provider/model identifiers, counts,
// timestamps and token numbers cross this boundary. The one exception is the
// project folder name, which is only read when the user opts in.

/** What an agent is doing right now, derived from live turn items / requests. */
export type ActivityKind =
  | "starting" // run preparing/starting, no provider turn yet
  | "thinking" // active reasoning item
  | "responding" // streaming assistant message
  | "editing" // active file_change, or an edit/write/patch tool
  | "command" // active command_execution
  | "searching" // active file_search, or read/grep/glob-like tool
  | "web" // active web_search, or web fetch tool
  | "tool" // some other dynamic/MCP tool
  | "approval" // pending approval request blocking the run
  | "question" // pending user_input request
  | "working"; // active run, finer activity unknown

export interface AgentRef {
  /** Provider instance id, e.g. "codex", "claudeAgent", "grok_grok_build". */
  instanceId: string | null;
  /** Provider driver, e.g. "codex", "claudeAgent", "grok", "opencode", "cursor", "acpRegistry", "pi", "muse", "antigravity". */
  driver: string | null;
  /** Model slug from the run's model selection, e.g. "claude-opus-5-5". */
  model: string | null;
}

export type ChildState = "executing" | "waiting" | "outstanding";

export interface ChildAgent {
  /** Stable dedupe key (child thread id, provider thread id or subagent id). Internal only. */
  key: string;
  origin: "app_owned" | "provider_native";
  agent: AgentRef;
  state: ChildState;
}

export interface ActiveThread {
  /** Internal identifier, never displayed. */
  threadId: string;
  runStatus: "preparing" | "starting" | "running" | "waiting";
  agent: AgentRef;
  /** Epoch ms when the current run started working. */
  startedAt: number | null;
  activity: ActivityKind;
  /** Direct + nested subagents/delegated children that are still active, deduplicated. */
  children: ChildAgent[];
  /** Project folder basename; only populated when `includeProjectNames` is set. */
  projectName: string | null;
  /** Non-subagent background work T3 is waiting on (provider monitors, background commands/tasks). */
  background?: BackgroundCounts;
}

export interface BackgroundCounts {
  monitors: number;
  commands: number;
  tasks: number;
}

export interface RunOutcome {
  status: "completed" | "failed" | "interrupted" | "cancelled";
  at: number;
  agent: AgentRef;
}

export interface T3Snapshot {
  takenAt: number;
  /**
   * Top-level active threads. Threads that are delegated children of another
   * active thread are folded into that parent's `children` and NOT listed here.
   */
  threads: ActiveThread[];
  /** Most recent finished run, for done/error/idle art. */
  lastOutcome: RunOutcome | null;
  /** Agent of the most recent run overall, used as the idle mascot. */
  lastAgent: AgentRef | null;
}

export interface TokenTotals {
  /** Input incl. cache reads + cache writes (as T3 reports it). */
  input: number;
  cachedInput: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
  /** input + output. */
  total: number;
  /** Number of usage records (turns / assistant messages). */
  turns: number;
  /** Distinct sessions, when the source knows them. */
  sessions?: number;
}

export interface UsageSummary {
  windowDays: number;
  since: number;
  totals: TokenTotals;
  /** Per provider driver. */
  byDriver: Record<string, TokenTotals>;
  computedAt: number;
  /** t3-usage = T3 Code's Usage page (all local agent sessions); t3-turns = turns run inside T3 only. */
  source?: "t3-usage" | "t3-turns";
}

export interface AppStatus {
  /** T3 Code server/desktop is running. */
  running: boolean;
  pid: number | null;
  port: number | null;
  serverVersion: string | null;
  /** Path of the state database that was found. */
  dbPath: string | null;
}
