// The daemon loop: watch T3 Code, decide what to show, keep Discord in sync.

import { readFile } from "node:fs/promises";
import { DynamicArt } from "./art/dynamic.ts";
import { type Config, rpcHome } from "./config.ts";
import type { DiscordActivity } from "./discord/activity.ts";
import { PresenceClient } from "./discord/presence.ts";
import { buildActivity } from "./presence/activity.ts";
import { type Decision, Director } from "./presence/director.ts";
import { T3Database } from "./t3/db.ts";
import { detectApp } from "./t3/detect.ts";
import { type Instances, readInstances } from "./t3/instances.ts";
import { resolveT3Paths, type T3Paths } from "./t3/paths.ts";
import { StateReader } from "./t3/state.ts";
import { readUsage } from "./t3/usage.ts";
import type { AppStatus, T3Snapshot, UsageSummary } from "./types.ts";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function makeLogger(debug = !!process.env.T3CODE_RPC_DEBUG): Logger {
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

export interface Frame {
  app: AppStatus;
  snapshot: T3Snapshot | null;
  usage: UsageSummary | null;
  decision: Decision | null;
  activity: DiscordActivity | null;
}

/** Everything the daemon knows at one instant. Used by the daemon and by `status`/`preview`. */
export class Observer {
  readonly paths: T3Paths;
  readonly director = new Director();
  #db: T3Database | null = null;
  #reader: StateReader | null = null;
  #usage: UsageSummary | null = null;
  #usageAt = 0;
  #app: AppStatus = { running: false, pid: null, port: null, serverVersion: null, dbPath: null };
  #appAt = 0;
  #appStartedAt: number | null = null;
  readonly cfg: Config;
  readonly dynamic: DynamicArt | null;
  readonly log: Logger;

  constructor(cfg: Config, log: Logger, opts: { dynamic?: boolean } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.paths = resolveT3Paths({ home: cfg.t3Home ?? undefined });
    const d = cfg.art.dynamic;
    this.dynamic =
      opts.dynamic !== false && d.enabled
        ? new DynamicArt({ repo: d.githubRepo, branch: d.branch, artVersion: cfg.art.version, maxOrbiters: d.maxOrbiters, home: rpcHome(), logger: log })
        : null;
  }

  async app(now = Date.now()): Promise<AppStatus> {
    if (now - this.#appAt >= APP_CHECK_MS) {
      this.#appAt = now;
      this.#app = await detectApp({ paths: this.paths });
      if (this.#app.running) {
        try {
          const rec = JSON.parse(await readFile(this.paths.runtimePath, "utf8"));
          const at = Date.parse(rec?.startedAt);
          this.#appStartedAt = Number.isFinite(at) ? at : null;
        } catch {
          this.#appStartedAt = null;
        }
      }
    }
    return this.#app;
  }

  get appStartedAt(): number | null {
    return this.#appStartedAt;
  }

  #ensureReader(): StateReader | null {
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

  closeDb(): void {
    this.#reader = null;
    this.#db?.close();
    this.#db = null;
  }

  instances(): Instances {
    return readInstances(this.paths.settingsPath);
  }

  async frame(now = Date.now()): Promise<Frame> {
    const app = await this.app(now);
    let snapshot: T3Snapshot | null = null;
    if (app.running) {
      try {
        const reader = this.#ensureReader();
        snapshot = reader ? reader.read(now) : null;
        if (this.#db && (now - this.#usageAt >= USAGE_REFRESH_MS || !this.#usage)) {
          this.#usageAt = now;
          this.#usage = readUsage(this.#db, { windowDays: this.cfg.tokens.windowDays, now });
        }
      } catch (err) {
        this.log.warn(`state read failed: ${(err as Error).message}`);
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
  readonly observer: Observer;
  readonly presence: PresenceClient;
  readonly log: Logger;
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;
  #closedSince: number | null = null;
  #lastMood = "";
  #ticking = false;

  constructor(cfg: Config, log: Logger) {
    this.log = log;
    this.observer = new Observer(cfg, log);
    this.presence = new PresenceClient({ clientId: cfg.clientId, logger: log });
    this.observer.dynamic?.onReady(() => void this.tick());
  }

  async start(): Promise<void> {
    this.log.info(`t3code-rpc starting (client ${this.observer.cfg.clientId}, T3 home ${this.observer.paths.home})`);
    this.presence.start();
    await this.tick();
    this.#timer = setInterval(() => void this.tick(), this.observer.cfg.pollMs);
  }

  async tick(): Promise<void> {
    if (this.#stopping || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = Date.now();
      const f = await this.observer.frame(now);
      if (!f.app.running) {
        this.#closedSince ??= now;
        this.observer.closeDb();
        if (this.observer.cfg.clearWhenClosed && now - this.#closedSince >= CLOSED_GRACE_MS) this.presence.set(null);
        this.#logMood("closed");
        return;
      }
      this.#closedSince = null;
      this.presence.set(f.activity);
      this.#logMood(f.decision?.mood ?? "hidden");
    } catch (err) {
      this.log.error(`tick failed: ${(err as Error).stack ?? err}`);
    } finally {
      this.#ticking = false;
    }
  }

  #logMood(mood: string): void {
    if (mood !== this.#lastMood) {
      this.log.info(`presence → ${mood}`);
      this.#lastMood = mood;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.observer.closeDb();
    await this.presence.stop();
    this.log.info("t3code-rpc stopped");
  }
}
