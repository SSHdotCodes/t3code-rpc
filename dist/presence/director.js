// Decides what the presence should show: which animation, which lines of
// text, which badge. Pure input → output apart from small hold/streak memory.
//
// Privacy: inputs are T3Snapshot/UsageSummary, which by construction carry no
// chat titles or contents. Keep it that way — never add free text from T3 here.
import { agentLabel, breakdown, characterFor, formatTokens, plural, windowLabel } from "./format.js";
const ACTIVITY = {
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
/**
 * Every subagent T3 is still waiting on — executing, queued, or finished but not yet
 * reported back. This matches T3's own "Waiting on N subagents" count.
 */
const liveChildren = (t) => t.children;
const working = (cs) => cs.filter((c) => c.state !== "outstanding").length;
function backgroundNote(threads) {
    const sum = { monitors: 0, commands: 0, tasks: 0 };
    for (const t of threads) {
        sum.monitors += t.background?.monitors ?? 0;
        sum.commands += t.background?.commands ?? 0;
        sum.tasks += t.background?.tasks ?? 0;
    }
    const parts = [
        sum.monitors ? plural(sum.monitors, "monitor") : "",
        sum.commands ? plural(sum.commands, "command") : "",
        sum.tasks ? plural(sum.tasks, "background task") : "",
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
}
export function tokenLine(cfg, usage) {
    if (!cfg.tokens.show || !usage)
        return null;
    const t = usage.totals;
    const value = cfg.tokens.metric === "output" ? t.output : cfg.tokens.metric === "fresh" ? Math.max(0, t.total - t.cachedInput) : t.total;
    const noun = cfg.tokens.metric === "output" ? "output tokens" : "tokens";
    return `⚡ ${formatTokens(value)} ${noun} · ${windowLabel(usage.windowDays)}`;
}
function tokenHover(usage) {
    if (!usage)
        return null;
    const t = usage.totals;
    const hit = t.input > 0 ? Math.round((t.cachedInput / t.input) * 100) : 0;
    return `${formatTokens(t.total)} tokens ${windowLabel(usage.windowDays)} · ${formatTokens(t.output)} out · ${hit}% cached · ${plural(t.turns, "turn")}`;
}
export class Director {
    lastShownOutcomeAt = 0;
    decide(input) {
        const { cfg, app, snapshot, usage } = input;
        const now = input.now ?? Date.now();
        if (!app.running || !snapshot)
            return null;
        const names = input.instances ?? {};
        const tokens = tokenLine(cfg, usage);
        const hover = tokenHover(usage);
        const label = (a) => (cfg.showModel ? agentLabel(a, names) : agentLabel({ ...a, model: null }, names));
        const threads = snapshot.threads;
        if (threads.length === 0)
            return this.restful(input, now, tokens, hover, label);
        const busySince = threads.reduce((min, t) => (t.startedAt && (!min || t.startedAt < min) ? t.startedAt : min), null);
        const project = cfg.showProject ? (threads.find((t) => t.projectName)?.projectName ?? null) : null;
        const withProject = (s) => (project ? `${s} · ${project}` : s);
        const conductors = threads.filter((t) => liveChildren(t).length > 0);
        // One agent, nobody else around: show exactly what it is doing.
        if (threads.length === 1 && conductors.length === 0) {
            const t = threads[0];
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
        const conductorThread = conductors.length === 1 ? conductors[0] : null;
        const orbitAgents = [];
        if (conductorThread) {
            for (const c of liveChildren(conductorThread))
                orbitAgents.push(c.agent);
        }
        else {
            for (const t of threads) {
                orbitAgents.push(t.agent);
                for (const c of liveChildren(t))
                    orbitAgents.push(c.agent);
            }
        }
        const others = conductorThread ? threads.filter((t) => t !== conductorThread) : [];
        const otherAgents = others.reduce((n, t) => n + 1 + liveChildren(t).length, 0);
        const count = orbitAgents.length;
        const conductor = conductorThread ? characterFor(conductorThread.agent, names) : "t3";
        const waiting = threads.filter((t) => t.activity === "approval" || t.activity === "question").length;
        const team = breakdown(orbitAgents, names);
        const lead = conductorThread ? label(conductorThread.agent) : null;
        const details = conductorThread ? `🪄 Orchestrating ${plural(count, "agent")}` : `🪄 Running ${count} agents at once`;
        const extras = [
            otherAgents ? `+${plural(otherAgents, "more agent")}` : "",
            backgroundNote(conductorThread ? [conductorThread] : threads) ?? "",
            waiting ? `${waiting} waiting on me` : "",
        ].filter(Boolean);
        const busy = conductorThread ? working(liveChildren(conductorThread)) : null;
        const teamLine = withProject(lead ? `${lead} → ${team}` : team) + extras.map((e) => ` · ${e}`).join("");
        return {
            art: { kind: "orbit", conductor, orbiters: orbitAgents.map((a) => characterFor(a, names)), count },
            details,
            stateLines: [teamLine, ...(tokens ? [tokens] : [])],
            largeText: lead ? `${lead} conducting ${team}${busy !== null && busy < count ? ` · ${busy} working right now` : ""}` : `T3 Code juggling ${team}`,
            badge: conductorThread ? conductor : "t3",
            smallText: hover ?? (lead ?? "T3 Code"),
            startedAt: busySince,
            mood: `orbit:${conductor}:${count}`,
        };
    }
    /** Nothing running: celebrate, sulk, or nap. */
    restful(input, now, tokens, hover, label) {
        const { cfg, snapshot } = input;
        const outcome = snapshot.lastOutcome;
        const lastAgent = outcome?.agent ?? snapshot.lastAgent;
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
        if (!cfg.showIdle)
            return null;
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
