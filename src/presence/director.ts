// Decides what the presence should show: which animation, which lines of
// text, which badge. Pure input → output apart from small hold/streak memory.
//
// Privacy: inputs are T3Snapshot/UsageSummary, which by construction carry no
// chat titles or contents. Keep it that way — never add free text from T3 here.

import type { Config } from "../config.ts";
import type { CharacterKind } from "../render/characters.ts";
import type { Orbiter, SceneKind } from "../render/scenes.ts";
import type { ActiveThread, ActivityKind, AgentRef, AppStatus, ChildAgent, T3Snapshot, UsageSummary } from "../types.ts";
import type { Instances } from "../t3/instances.ts";
import { agentLabel, breakdown, characterFor, formatTokens, plural, windowLabel } from "./format.ts";

export type ActivityScene = Exclude<SceneKind, "orbit">;

export type ArtChoice =
  | { kind: "activity"; scene: ActivityScene; character: CharacterKind }
  | { kind: "orbit"; conductor: CharacterKind; orbiters: Orbiter[]; count: number };

export interface Decision {
  art: ArtChoice;
  details: string;
  /** Candidate second lines; the daemon rotates through them. */
  stateLines: string[];
  largeText: string;
  badge: CharacterKind;
  smallText: string;
  /** Epoch ms for the elapsed timer, or null. */
  startedAt: number | null;
  /** Short machine-readable label for logs/status. */
  mood: string;
}

const ACTIVITY: Record<ActivityKind, { scene: ActivityScene; details: string; verb: string }> = {
  starting: { scene: "thinking", details: "🚀 Warming up", verb: "is warming up" },
  thinking: { scene: "thinking", details: "💭 Thinking", verb: "is thinking" },
  responding: { scene: "thinking", details: "✍️ Writing a reply", verb: "is writing a reply" },
  editing: { scene: "coding", details: "⌨️ Editing code", verb: "is editing code" },
  command: { scene: "terminal", details: "🖥️ Running commands", verb: "is running commands" },
  searching: { scene: "reading", details: "🔍 Reading the codebase", verb: "is reading the codebase" },
  web: { scene: "web", details: "🌐 Browsing the web", verb: "is browsing the web" },
  tool: { scene: "terminal", details: "🧩 Using tools", verb: "is using tools" },
  approval: { scene: "waiting", details: "✋ Waiting for approval", verb: "is waiting for approval" },
  question: { scene: "waiting", details: "❓ Waiting for an answer", verb: "has a question" },
  working: { scene: "coding", details: "🛠️ Working", verb: "is working" },
};

export interface DecideInput {
  cfg: Config;
  app: AppStatus;
  snapshot: T3Snapshot | null;
  usage: UsageSummary | null;
  instances?: Instances;
  /** When T3 Code was opened (server start), epoch ms. */
  appStartedAt?: number | null;
  now?: number;
}

const liveChildren = (t: ActiveThread): ChildAgent[] => t.children.filter((c) => c.state !== "outstanding");

export function tokenLine(cfg: Config, usage: UsageSummary | null): string | null {
  if (!cfg.tokens.show || !usage) return null;
  const t = usage.totals;
  const value = cfg.tokens.metric === "output" ? t.output : cfg.tokens.metric === "fresh" ? Math.max(0, t.total - t.cachedInput) : t.total;
  const noun = cfg.tokens.metric === "output" ? "output tokens" : "tokens";
  return `⚡ ${formatTokens(value)} ${noun} · ${windowLabel(usage.windowDays)}`;
}

function tokenHover(usage: UsageSummary | null): string | null {
  if (!usage) return null;
  const t = usage.totals;
  const hit = t.input > 0 ? Math.round((t.cachedInput / t.input) * 100) : 0;
  return `${formatTokens(t.total)} tokens ${windowLabel(usage.windowDays)} · ${formatTokens(t.output)} out · ${hit}% cached · ${plural(t.turns, "turn")}`;
}

export class Director {
  private lastShownOutcomeAt = 0;

  decide(input: DecideInput): Decision | null {
    const { cfg, app, snapshot, usage } = input;
    const now = input.now ?? Date.now();
    if (!app.running || !snapshot) return null;
    const names = input.instances ?? {};
    const tokens = tokenLine(cfg, usage);
    const hover = tokenHover(usage);
    const label = (a: AgentRef) => (cfg.showModel ? agentLabel(a, names) : agentLabel({ ...a, model: null }, names));

    const threads = snapshot.threads;
    if (threads.length === 0) return this.restful(input, now, tokens, hover, label);

    const busySince = threads.reduce<number | null>((min, t) => (t.startedAt && (!min || t.startedAt < min) ? t.startedAt : min), null);
    const project = cfg.showProject ? (threads.find((t) => t.projectName)?.projectName ?? null) : null;
    const withProject = (s: string) => (project ? `${s} · ${project}` : s);
    const conductors = threads.filter((t) => liveChildren(t).length > 0);

    // One agent, nobody else around: show exactly what it is doing.
    if (threads.length === 1 && conductors.length === 0) {
      const t = threads[0]!;
      const a = ACTIVITY[t.activity] ?? ACTIVITY.working;
      const character = characterFor(t.agent, names);
      return {
        art: { kind: "activity", scene: a.scene, character },
        details: a.details,
        stateLines: [withProject(label(t.agent)), ...(tokens ? [tokens] : [])],
        largeText: `${label(t.agent)} ${a.verb}`,
        badge: character,
        smallText: hover ?? label(t.agent),
        startedAt: busySince,
        mood: `single:${t.activity}`,
      };
    }

    // Several agents. With exactly one orchestrating thread, its own subagents
    // orbit it (exact count) and other threads are mentioned in text. Otherwise
    // T3 Code itself conducts every running agent.
    const conductorThread = conductors.length === 1 ? conductors[0]! : null;
    const orbitAgents: AgentRef[] = [];
    if (conductorThread) {
      for (const c of liveChildren(conductorThread)) orbitAgents.push(c.agent);
    } else {
      for (const t of threads) {
        orbitAgents.push(t.agent);
        for (const c of liveChildren(t)) orbitAgents.push(c.agent);
      }
    }
    const others = conductorThread ? threads.filter((t) => t !== conductorThread) : [];
    const otherAgents = others.reduce((n, t) => n + 1 + liveChildren(t).length, 0);
    const count = orbitAgents.length;
    const conductor: CharacterKind = conductorThread ? characterFor(conductorThread.agent, names) : "t3";
    const waiting = threads.filter((t) => t.activity === "approval" || t.activity === "question").length;
    const team = breakdown(orbitAgents, names);
    const lead = conductorThread ? label(conductorThread.agent) : null;
    const details = conductorThread ? `🪄 Orchestrating ${plural(count, "agent")}` : `🪄 Running ${count} agents at once`;
    const extras = [otherAgents ? `+${plural(otherAgents, "more agent")}` : "", waiting ? `${waiting} waiting on me` : ""].filter(Boolean);
    const teamLine = withProject(lead ? `${lead} → ${team}` : team) + extras.map((e) => ` · ${e}`).join("");
    return {
      art: { kind: "orbit", conductor, orbiters: orbitAgents.map((a) => characterFor(a, names)), count },
      details,
      stateLines: [teamLine, ...(tokens ? [tokens] : [])],
      largeText: lead ? `${lead} conducting ${team}` : `T3 Code juggling ${team}`,
      badge: conductorThread ? conductor : "t3",
      smallText: hover ?? (lead ?? "T3 Code"),
      startedAt: busySince,
      mood: `orbit:${conductor}:${count}`,
    };
  }

  /** Nothing running: celebrate, sulk, or nap. */
  private restful(input: DecideInput, now: number, tokens: string | null, hover: string | null, label: (a: AgentRef) => string): Decision | null {
    const { cfg, snapshot } = input;
    const outcome = snapshot!.lastOutcome;
    const lastAgent = outcome?.agent ?? snapshot!.lastAgent;
    const character = characterFor(lastAgent, input.instances ?? {});
    const appStart = input.appStartedAt ?? null;

    if (outcome && (outcome.status === "completed" || outcome.status === "failed")) {
      const hold = (outcome.status === "completed" ? cfg.doneHoldSec : cfg.errorHoldSec) * 1000;
      if (now - outcome.at < hold) {
        this.lastShownOutcomeAt = outcome.at;
        const done = outcome.status === "completed";
        return {
          art: { kind: "activity", scene: done ? "done" : "error", character },
          details: done ? "✨ Task complete" : "🌧️ Hit a snag",
          stateLines: [label(outcome.agent), ...(tokens ? [tokens] : [])],
          largeText: done ? `${label(outcome.agent)} finished a task` : `${label(outcome.agent)} ran into a problem`,
          badge: character,
          smallText: hover ?? label(outcome.agent),
          startedAt: appStart,
          mood: done ? "done" : "error",
        };
      }
    }
    if (!cfg.showIdle) return null;
    return {
      art: { kind: "activity", scene: "idle", character },
      details: "💤 Idle",
      stateLines: tokens ? [tokens] : [lastAgent ? label(lastAgent) : "Ready for the next task"],
      largeText: lastAgent ? `${label(lastAgent)} is napping` : "Napping",
      badge: lastAgent ? character : "t3",
      smallText: hover ?? "T3 Code",
      startedAt: appStart,
      mood: "idle",
    };
  }
}
