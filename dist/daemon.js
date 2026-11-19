// The daemon loop: watch T3 Code, decide what to show, keep Discord in sync.
import { copyFileSync, existsSync, readdirSync, statSync, truncateSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DynamicArt } from "./art/dynamic.js";
import { configPath, loadConfig, rpcHome } from "./config.js";
import { PresenceClient } from "./discord/presence.js";
import { buildActivity } from "./presence/activity.js";
import { Director } from "./presence/director.js";
import { T3Database } from "./t3/db.js";
import { detectApp } from "./t3/detect.js";
import { readInstances } from "./t3/instances.js";
import { resolveT3Paths } from "./t3/paths.js";
import { StateReader } from "./t3/state.js";
import { readUsage } from "./t3/usage.js";
import { readUsagePage } from "./t3/usagePage.js";
export function makeLogger(debug = !!process.env.T3CODE_RPC_DEBUG) {
    const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
    return {
        debug: (m) => debug && console.log(`${stamp()} debug ${m}`),
        info: (m) => console.log(`${stamp()} info  ${m}`),
        warn: (m) => console.warn(`${stamp()} warn  ${m}`),
        error: (m) => console.error(`${stamp()} error ${m}`),
    };
}
const APP_CHECK_MS = 3000;
const USAGE_REFRESH_MS = 60_000;
const CLOSED_GRACE_MS = 8000;
const LOG_ROTATE_CHECK_MS = 60 * 60_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** A new scene must hold this long before it replaces the current one… */
const SETTLE_MS = 2000;
/** …and a scene stays up at least this long, so quick tool hops don't flicker the art. */
const DWELL_MS = 6000;
const URGENT = /approval|question|waiting|^done$|^error$|^idle$|^hidden$/;
/** Prevents quick tool hops from flickering the art while letting urgent states through immediately. */
export class MoodStabilizer {
    #shownMood = "";
    #shownAt = 0;
    #candidate = "";
    #candidateSince = 0;
    #settleMs;
    #dwellMs;
    constructor(settleMs = SETTLE_MS, dwellMs = DWELL_MS) {
        this.#settleMs = settleMs;
        this.#dwellMs = dwellMs;
    }
    reset() {
        this.#shownMood = "";
        this.#shownAt = 0;
        this.#candidate = "";
        this.#candidateSince = 0;
    }
    accept(mood, now) {
        if (mood === this.#shownMood) {
            this.#candidate = "";
            this.#candidateSince = 0;
            return true;
        }
        if (mood !== this.#candidate) {
            this.#candidate = mood;
            this.#candidateSince = now;
        }
        const settled = now - this.#candidateSince >= this.#settleMs && now - this.#shownAt >= this.#dwellMs;
        if (!settled && !URGENT.test(mood) && this.#shownMood !== "")
            return false;
        this.#shownMood = mood;
        this.#shownAt = now;
        this.#candidate = "";
        this.#candidateSince = 0;
        return true;
    }
}
/** Rotate daemon.log in place (copy + truncate) so open O_APPEND descriptors (e.g. launchd) stay valid. */
export function rotateLogIfNeeded(path, maxBytes = MAX_LOG_BYTES) {
    try {
        const st = statSync(path);
        if (st.size < maxBytes)
            return false;
        copyFileSync(path, `${path}.1`);
        truncateSync(path, 0);
        return true;
    }
    catch {
        return false;
    }
}
function hasActiveRuns(dbPath) {
    let db = null;
    try {
        db = new T3Database(dbPath);
        if (!db.hasV2)
            return false;
        const activeRun = db.get("SELECT 1 AS x FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id WHERE r.status IN ('queued','preparing','starting','running','waiting') AND r.status <> 'queued' AND t.deleted_at IS NULL AND t.archived_at IS NULL LIMIT 1");
        if (activeRun)
            return true;
        const activeSubagent = db.get("SELECT 1 AS x FROM orchestration_v2_projection_nodes n JOIN orchestration_v2_projection_threads t ON t.thread_id = n.thread_id WHERE n.status IN ('pending','starting','running','waiting') AND n.kind = 'subagent' AND t.deleted_at IS NULL AND t.archived_at IS NULL LIMIT 1");
        return !!activeSubagent;
    }
    catch {
        return false;
    }
    finally {
        db?.close();
    }
}
function configIdentity(path) {
    try {
        const st = statSync(path);
        return `${st.ino}:${st.mtimeMs}:${st.size}`;
    }
    catch {
        return "missing";
    }
}
/** Everything the daemon knows at one instant. Used by the daemon and by `status`/`preview`. */
/**
 * T3 Code homes worth watching: an explicit config/env home wins; otherwise
 * ~/.t3 (default for SSHCode, T3 Code stable and nightly) plus any ~/.t3-*
 * folder that has a server runtime record (custom --base-dir installs).
 */
export function candidateHomes(explicit) {
    if (explicit)
        return [explicit];
    const homes = [process.env.T3CODE_HOME?.trim(), join(homedir(), ".t3")].filter((h) => !!h);
    try {
        for (const entry of readdirSync(homedir())) {
            if (!entry.startsWith(".t3-"))
                continue;
            const dir = join(homedir(), entry);
            if (existsSync(join(dir, "userdata", "server-runtime.json")))
                homes.push(dir);
        }
    }
    catch {
        /* unreadable home dir */
    }
    return [...new Set(homes)];
}
export class Observer {
    #paths;
    director = new Director();
    #db = null;
    #reader = null;
    #usage = null;
    #usageAt = 0;
    #app = { running: false, pid: null, port: null, serverVersion: null, dbPath: null };
    #appAt = 0;
    #appStartedAt = null;
    #lastActiveThreads = 0;
    #cfg;
    #dynamic;
    #allowDynamic;
    #onDynamicReady = null;
    log;
    constructor(cfg, log, opts = {}) {
        this.#cfg = cfg;
        this.log = log;
        this.#allowDynamic = opts.dynamic !== false;
        this.#paths = resolveT3Paths({ home: candidateHomes(cfg.t3Home)[0] });
        this.#dynamic = this.#makeDynamic(cfg);
    }
    get cfg() {
        return this.#cfg;
    }
    get dynamic() {
        return this.#dynamic;
    }
    onDynamicReady(fn) {
        this.#onDynamicReady = fn;
        this.#dynamic?.onReady(fn);
    }
    #makeDynamic(cfg) {
        const d = cfg.art.dynamic;
        if (!this.#allowDynamic || !d.enabled)
            return null;
        const dyn = new DynamicArt({ repo: d.githubRepo, branch: d.branch, artVersion: cfg.art.version, maxOrbiters: d.maxOrbiters, home: rpcHome(), logger: this.log });
        if (this.#onDynamicReady)
            dyn.onReady(this.#onDynamicReady);
        return dyn;
    }
    reloadConfig(next) {
        const prev = this.#cfg;
        this.#cfg = next;
        if (prev.t3Home !== next.t3Home) {
            this.closeDb();
            this.#paths = resolveT3Paths({ home: candidateHomes(next.t3Home)[0] });
            this.#appAt = 0;
            this.#usage = null;
            this.#usageAt = 0;
        }
        if (prev.showProject !== next.showProject) {
            this.#reader = null;
        }
        if (prev.tokens.windowDays !== next.tokens.windowDays || prev.tokens.source !== next.tokens.source) {
            this.#usage = null;
            this.#usageAt = 0;
        }
        const prevDyn = JSON.stringify([prev.art.dynamic, prev.art.version]);
        const nextDyn = JSON.stringify([next.art.dynamic, next.art.version]);
        if (prevDyn !== nextDyn) {
            this.#dynamic = this.#makeDynamic(next);
        }
    }
    get paths() {
        return this.#paths;
    }
    async app(now = Date.now()) {
        if (now - this.#appAt >= APP_CHECK_MS) {
            this.#appAt = now;
            // Follow whichever T3 Code home is running; if multiple are open, prefer one with active work.
            const homes = candidateHomes(this.#cfg.t3Home);
            const ordered = [this.#paths.home, ...homes.filter((h) => h !== this.#paths.home)];
            const running = [];
            for (const home of ordered) {
                const paths = resolveT3Paths({ home });
                const app = await detectApp({ paths });
                if (app.running)
                    running.push({ paths, app });
                else if (home === this.#paths.home)
                    this.#app = app;
            }
            let found = running[0] ?? null;
            if (running.length > 1) {
                const currentRunning = running[0].paths.home === this.#paths.home;
                const currentBusy = currentRunning && (this.#lastActiveThreads > 0 || (running[0].app.dbPath ? hasActiveRuns(running[0].app.dbPath) : false));
                if (!currentBusy) {
                    const busyOther = running.slice(currentRunning ? 1 : 0).find((r) => r.app.dbPath && hasActiveRuns(r.app.dbPath));
                    if (busyOther)
                        found = busyOther;
                }
            }
            if (found && found.paths.home !== this.#paths.home) {
                this.log.info(`following T3 Code at ${found.paths.home}`);
                this.closeDb();
                this.#usage = null;
                this.#usageAt = 0;
                this.#lastActiveThreads = 0;
                this.#paths = found.paths;
            }
            if (found)
                this.#app = found.app;
            if (this.#app.running) {
                try {
                    const rec = JSON.parse(await readFile(this.paths.runtimePath, "utf8"));
                    const at = Date.parse(rec?.startedAt);
                    this.#appStartedAt = Number.isFinite(at) ? at : null;
                }
                catch {
                    this.#appStartedAt = null;
                }
            }
        }
        return this.#app;
    }
    get appStartedAt() {
        return this.#appStartedAt;
    }
    #ensureReader() {
        if (!this.#reader) {
            if (!this.#db) {
                this.#db = new T3Database(this.paths.dbPath);
                if (!this.#db.hasV2) {
                    this.#db.close();
                    this.#db = null;
                    return null;
                }
            }
            this.#reader = new StateReader(this.#db, { includeProjectNames: this.#cfg.showProject });
        }
        return this.#reader;
    }
    /** Token usage from the configured source, falling back to T3's per-turn records. */
    async usage(now = Date.now(), windowDays = this.#cfg.tokens.windowDays) {
        if (this.#cfg.tokens.source === "t3-usage") {
            try {
                const page = await readUsagePage(this.paths.userdataDir, { windowDays, now });
                if (page)
                    return page;
            }
            catch (err) {
                this.log.warn(`usage page read failed: ${err.message}`);
            }
        }
        if (!this.#db)
            this.#ensureReader();
        return this.#db ? { ...readUsage(this.#db, { windowDays, now }), source: "t3-turns" } : null;
    }
    closeDb() {
        this.#reader = null;
        this.#db?.close();
        this.#db = null;
    }
    instances() {
        return readInstances(this.paths.settingsPath);
    }
    async frame(now = Date.now()) {
        const app = await this.app(now);
        let snapshot = null;
        if (app.running) {
            try {
                const reader = this.#ensureReader();
                snapshot = reader ? reader.read(now) : null;
                this.#lastActiveThreads = snapshot?.threads.length ?? 0;
                if (now - this.#usageAt >= USAGE_REFRESH_MS || !this.#usage) {
                    this.#usageAt = now;
                    this.#usage = (await this.usage(now)) ?? this.#usage;
                }
            }
            catch (err) {
                this.log.warn(`state read failed: ${err.message}`);
                this.closeDb();
            }
        }
        else {
            this.#lastActiveThreads = 0;
        }
        const decision = this.director.decide({
            cfg: this.#cfg,
            app,
            snapshot,
            usage: this.#usage,
            instances: this.instances(),
            appStartedAt: this.#appStartedAt,
            now,
        });
        const activity = decision ? buildActivity(this.#cfg, decision, this.#dynamic, now) : null;
        return { app, snapshot, usage: this.#usage, decision, activity };
    }
}
export class Daemon {
    observer;
    #presence;
    log;
    #stabilizer = new MoodStabilizer();
    #timer = null;
    #stopping = false;
    #closedSince = null;
    #lastMood = "";
    #ticking = false;
    #configIdentity = "";
    #configCheckAt = 0;
    #logRotateAt = 0;
    #logPath;
    constructor(cfg, log, opts = {}) {
        this.log = log;
        this.#logPath = opts.logPath ?? null;
        this.observer = new Observer(cfg, log);
        this.#presence = new PresenceClient({ clientId: cfg.clientId, logger: log });
        this.observer.onDynamicReady(() => void this.tick());
        this.#configIdentity = configIdentity(configPath());
    }
    get presence() {
        return this.#presence;
    }
    reloadConfig(explicit) {
        const file = configPath();
        this.#configIdentity = configIdentity(file);
        let next;
        try {
            next = explicit ?? loadConfig();
        }
        catch (err) {
            this.log.warn(`config reload skipped: ${err.message}`);
            return false;
        }
        const prev = this.observer.cfg;
        this.observer.reloadConfig(next);
        if (prev.pollMs !== next.pollMs && this.#timer) {
            clearInterval(this.#timer);
            this.#timer = setInterval(() => void this.tick(), next.pollMs);
        }
        if (prev.clientId !== next.clientId) {
            const old = this.#presence;
            this.#presence = new PresenceClient({ clientId: next.clientId, logger: this.log });
            this.#presence.start();
            void old.stop().catch(() => { });
        }
        this.#stabilizer.reset();
        this.log.info("config reloaded");
        return true;
    }
    async start() {
        if (this.#logPath)
            rotateLogIfNeeded(this.#logPath);
        this.#logRotateAt = Date.now();
        this.log.info(`t3code-rpc starting (client ${this.observer.cfg.clientId}, T3 home ${this.observer.paths.home})`);
        this.#presence.start();
        await this.tick();
        this.#timer = setInterval(() => void this.tick(), this.observer.cfg.pollMs);
    }
    async tick() {
        if (this.#stopping || this.#ticking)
            return;
        this.#ticking = true;
        try {
            const now = Date.now();
            if (this.#logPath && now - this.#logRotateAt >= LOG_ROTATE_CHECK_MS) {
                this.#logRotateAt = now;
                rotateLogIfNeeded(this.#logPath);
            }
            if (now - this.#configCheckAt >= APP_CHECK_MS) {
                this.#configCheckAt = now;
                const id = configIdentity(configPath());
                if (id !== this.#configIdentity)
                    this.reloadConfig();
            }
            const f = await this.observer.frame(now);
            if (!f.app.running) {
                this.#closedSince ??= now;
                this.observer.closeDb();
                if (this.observer.cfg.clearWhenClosed && now - this.#closedSince >= CLOSED_GRACE_MS) {
                    this.#presence.set(null);
                    this.#stabilizer.reset();
                }
                this.#logMood("closed");
                return;
            }
            this.#closedSince = null;
            const mood = f.decision?.mood ?? "hidden";
            if (!this.#stabilizer.accept(mood, now))
                return;
            this.#presence.set(f.activity);
            this.#logMood(mood);
        }
        catch (err) {
            this.log.error(`tick failed: ${err.stack ?? err}`);
        }
        finally {
            this.#ticking = false;
        }
    }
    #logMood(mood) {
        if (mood !== this.#lastMood) {
            this.log.info(`presence → ${mood}`);
            this.#lastMood = mood;
        }
    }
    async stop() {
        this.#stopping = true;
        if (this.#timer)
            clearInterval(this.#timer);
        this.observer.closeDb();
        await this.#presence.stop();
        this.log.info("t3code-rpc stopped");
    }
}
