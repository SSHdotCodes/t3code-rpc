// The daemon loop: watch T3 Code, decide what to show, keep Discord in sync.
import { readFile } from "node:fs/promises";
import { DynamicArt } from "./art/dynamic.js";
import { rpcHome } from "./config.js";
import { PresenceClient } from "./discord/presence.js";
import { buildActivity } from "./presence/activity.js";
import { Director } from "./presence/director.js";
import { T3Database } from "./t3/db.js";
import { detectApp } from "./t3/detect.js";
import { readInstances } from "./t3/instances.js";
import { resolveT3Paths } from "./t3/paths.js";
import { StateReader } from "./t3/state.js";
import { readUsage } from "./t3/usage.js";
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
/** A new scene must hold this long before it replaces the current one… */
const SETTLE_MS = 2000;
/** …and a scene stays up at least this long, so quick tool hops don't flicker the art. */
const DWELL_MS = 6000;
const URGENT = /approval|question|^done$|^error$|^idle$/;
/** Everything the daemon knows at one instant. Used by the daemon and by `status`/`preview`. */
export class Observer {
    paths;
    director = new Director();
    #db = null;
    #reader = null;
    #usage = null;
    #usageAt = 0;
    #app = { running: false, pid: null, port: null, serverVersion: null, dbPath: null };
    #appAt = 0;
    #appStartedAt = null;
    cfg;
    dynamic;
    log;
    constructor(cfg, log, opts = {}) {
        this.cfg = cfg;
        this.log = log;
        this.paths = resolveT3Paths({ home: cfg.t3Home ?? undefined });
        const d = cfg.art.dynamic;
        this.dynamic =
            opts.dynamic !== false && d.enabled
                ? new DynamicArt({ repo: d.githubRepo, branch: d.branch, artVersion: cfg.art.version, maxOrbiters: d.maxOrbiters, home: rpcHome(), logger: log })
                : null;
    }
    async app(now = Date.now()) {
        if (now - this.#appAt >= APP_CHECK_MS) {
            this.#appAt = now;
            this.#app = await detectApp({ paths: this.paths });
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
            this.#db = new T3Database(this.paths.dbPath);
            if (!this.#db.hasV2) {
                this.#db.close();
                this.#db = null;
                return null;
            }
            this.#reader = new StateReader(this.#db, { includeProjectNames: this.cfg.showProject });
        }
        return this.#reader;
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
                if (this.#db && (now - this.#usageAt >= USAGE_REFRESH_MS || !this.#usage)) {
                    this.#usageAt = now;
                    this.#usage = readUsage(this.#db, { windowDays: this.cfg.tokens.windowDays, now });
                }
            }
            catch (err) {
                this.log.warn(`state read failed: ${err.message}`);
                this.closeDb();
            }
        }
        const decision = this.director.decide({
            cfg: this.cfg,
            app,
            snapshot,
            usage: this.#usage,
            instances: this.instances(),
            appStartedAt: this.#appStartedAt,
            now,
        });
        const activity = decision ? buildActivity(this.cfg, decision, this.dynamic, now) : null;
        return { app, snapshot, usage: this.#usage, decision, activity };
    }
}
export class Daemon {
    observer;
    presence;
    log;
    #timer = null;
    #stopping = false;
    #closedSince = null;
    #lastMood = "";
    #ticking = false;
    #shownMood = "";
    #shownAt = 0;
    #candidate = "";
    #candidateSince = 0;
    constructor(cfg, log) {
        this.log = log;
        this.observer = new Observer(cfg, log);
        this.presence = new PresenceClient({ clientId: cfg.clientId, logger: log });
        this.observer.dynamic?.onReady(() => void this.tick());
    }
    async start() {
        this.log.info(`t3code-rpc starting (client ${this.observer.cfg.clientId}, T3 home ${this.observer.paths.home})`);
        this.presence.start();
        await this.tick();
        this.#timer = setInterval(() => void this.tick(), this.observer.cfg.pollMs);
    }
    async tick() {
        if (this.#stopping || this.#ticking)
            return;
        this.#ticking = true;
        try {
            const now = Date.now();
            const f = await this.observer.frame(now);
            if (!f.app.running) {
                this.#closedSince ??= now;
                this.observer.closeDb();
                if (this.observer.cfg.clearWhenClosed && now - this.#closedSince >= CLOSED_GRACE_MS) {
                    this.presence.set(null);
                    this.#shownMood = "";
                }
                this.#logMood("closed");
                return;
            }
            this.#closedSince = null;
            const mood = f.decision?.mood ?? "hidden";
            if (mood !== this.#shownMood) {
                if (mood !== this.#candidate) {
                    this.#candidate = mood;
                    this.#candidateSince = now;
                }
                const settled = now - this.#candidateSince >= SETTLE_MS && now - this.#shownAt >= DWELL_MS;
                if (!settled && !URGENT.test(mood) && this.#shownMood !== "")
                    return;
                this.#shownMood = mood;
                this.#shownAt = now;
            }
            this.presence.set(f.activity);
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
        await this.presence.stop();
        this.log.info("t3code-rpc stopped");
    }
}
