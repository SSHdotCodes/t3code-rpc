// Human-friendly names for providers, models and token counts.

import type { CharacterKind } from "../render/characters.ts";
import type { Instances } from "../t3/instances.ts";
import type { AgentRef } from "../types.ts";

const DRIVER_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  cursor: "Cursor",
  gemini: "Gemini",
  antigravity: "Antigravity",
  pi: "Pi",
  muse: "Muse",
  acpRegistry: "ACP agent",
};

/** Kept as an alias so callers read naturally. */
export type InstanceNames = Instances;

export function providerName(agent: AgentRef, instances: Instances = {}): string {
  const label = agent.instanceId ? instances[agent.instanceId]?.displayName : undefined;
  if (label) return label;
  if (agent.driver && DRIVER_NAMES[agent.driver]) return DRIVER_NAMES[agent.driver]!;
  if (agent.driver) return titleCase(agent.driver);
  return "Agent";
}

const DRIVER_CHARACTERS: Array<[string, CharacterKind]> = [
  ["claude", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
  ["opencode", "opencode"],
  ["cursor", "cursor"],
  ["muse", "muse"],
  ["mistral", "mistral"],
  ["gemini", "gemini"],
  ["antigravity", "antigravity"],
  ["pi", "pi"],
];

/** Which logo represents an agent: harness first, then (for generic harnesses) its name, then the model family. */
export function characterFor(agent: AgentRef | null | undefined, instances: Instances = {}): CharacterKind {
  if (!agent) return "t3";
  const info = agent.instanceId ? instances[agent.instanceId] : undefined;
  const driver = (agent.driver ?? info?.driver ?? "").toLowerCase();
  const direct = DRIVER_CHARACTERS.find(([prefix]) => driver.startsWith(prefix));
  if (direct && driver !== "acpregistry") return direct[1];
  // ACP registry and other hosts: look at the agent id / display name / instance id
  const hints = [info?.agentId, info?.displayName, agent.instanceId].filter(Boolean).join(" ").toLowerCase();
  for (const [needle, kind] of DRIVER_CHARACTERS) if (needle !== "pi" && hints.includes(needle)) return kind;
  const model = (agent.model ?? "").toLowerCase();
  if (model.includes("claude") || /^(opus|sonnet|haiku|fable)/.test(model)) return "claude";
  if (model.startsWith("gpt") || model.includes("codex")) return "codex";
  if (model.startsWith("grok")) return "grok";
  if (model.includes("gemini")) return "gemini";
  if (model.includes("mistral") || model.includes("devstral")) return "mistral";
  return "generic";
}

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * "claude-opus-5-5" → "Claude Opus 5.5", "gpt-6.1-sol" → "GPT-6.1 Sol",
 * "grok-4.7-build-fast" → "Grok 4.7 Build Fast", "glm-5-3" → "GLM 5.3".
 */
export function modelName(model: string | null | undefined): string | null {
  if (!model) return null;
  let m = model.trim();
  if (!m || m === "default") return null;
  // provider-prefixed slugs like "openrouter/anthropic/claude-x" or "opencode-go/glm-5.2"
  if (m.includes("/")) m = m.slice(m.lastIndexOf("/") + 1);
  m = m.replace(/-\d{8}$/, ""); // dated snapshots
  const parts = m.split("-");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const next = parts[i + 1];
    // join version pairs "5-5" → "5.5"
    if (/^\d+$/.test(p) && next !== undefined && /^\d{1,2}$/.test(next)) {
      out.push(`${p}.${next}`);
      i++;
      continue;
    }
    out.push(p);
  }
  const words = out.map((w) => {
    const lw = w.toLowerCase();
    if (lw === "gpt") return "GPT";
    if (lw === "glm") return "GLM";
    if (/^o\d/.test(lw)) return lw;
    if (/^\d/.test(w)) return w;
    return w[0]!.toUpperCase() + w.slice(1);
  });
  // "GPT 6.1" reads better as "GPT-6.1"
  const joined = words.join(" ").replace(/^GPT (\d)/, "GPT-$1");
  return joined;
}

export function agentLabel(agent: AgentRef, instanceNames?: Instances): string {
  const model = modelName(agent.model);
  const provider = providerName(agent, instanceNames);
  if (!model) return provider;
  // Don't repeat the brand: "Claude Opus 5.5" not "Claude · Claude Opus 5.5"
  if (model.toLowerCase().startsWith(provider.toLowerCase())) return model;
  if (provider === "Claude" && /^(Opus|Sonnet|Haiku|Fable)/.test(model)) return `Claude ${model}`;
  return model;
}

export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const v = n / size;
      const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
      return `${Number(v.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.round(n));
}

export function windowLabel(days: number): string {
  if (days <= 0) return "all time";
  if (days === 1) return "today";
  if (days === 7) return "this week";
  return `last ${days} days`;
}

/** "3 Codex · 1 Claude · 1 Grok" from a list of agents. */
export function breakdown(agents: AgentRef[], instanceNames?: Instances): string {
  const counts = new Map<string, number>();
  for (const a of agents) {
    const name = providerName(a, instanceNames);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, c]) => `${c} ${name}`)
    .join(" · ");
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
