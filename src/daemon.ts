// The daemon loop: watch T3 Code, decide what to show, keep Discord in sync.

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
/** A new scene must hold this long before it replaces the current one… */
const SETTLE_MS = 2000;
/** …and a scene stays up at least this long, so quick tool hops don't flicker the art. */
const DWELL_MS = 6000;
const URGENT = /approval|question|^done$|^error$|^idle$/;

export interface Frame {
  app: AppStatus;
  snapshot: T3Snapshot | null;
  usage: UsageSummary | null;
  decision: Decision | null;
  activity: DiscordActivity | null;
}

/** Everything the daemon knows at one instant. Used by the daemon and by `status`/`preview`. */
/**
 * T3 Code homes worth watching: an explicit config/env home wins; otherwise
 * ~/.t3 (default for SSHCode, T3 Code stable and nightly) plus any ~/.t3-*
 * folder that has a server runtime record (custom --base-dir installs).
 */
export function candidateHomes(explicit: string | null): string[] {
  if (explicit) return [explicit];
  const homes = [process.env.T3CODE_HOME?.trim(), join(homedir(), ".t3")].filter((h): h is string => !!h);
  try {
    for (const entry of readdirSync(homedir())) {
      if (!entry.startsWith(".t3-")) continue;
      const dir = join(homedir(), entry);
      if (existsSync(join(dir, "userdata", "server-runtime.json"))) homes.push(dir);
    }
  } catch {
    /* unreadable home dir */
  }
  return [...new Set(homes)];
}

export class Observer {
  #paths: T3Paths;
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
    this.#paths = resolveT3Paths({ home: candidateHomes(cfg.t3Home)[0] });
    const d = cfg.art.dynamic;
    this.dynamic =
      opts.dynamic !== false && d.enabled
        ? new DynamicArt({ repo: d.githubRepo, branch: d.branch, artVersion: cfg.art.version, maxOrbiters: d.maxOrbiters, home: rpcHome(), logger: log })
        : null;
  }

  get paths(): T3Paths {
    return this.#paths;
  }

  async app(now = Date.now()): Promise<AppStatus> {
    if (now - this.#appAt >= APP_CHECK_MS) {
      this.#appAt = now;
      // Follow whichever T3 Code home is running (current one first, so we don't flap).
      const homes = candidateHomes(this.cfg.t3Home);
      const ordered = [this.#paths.home, ...homes.filter((h) => h !== this.#paths.home)];
      let found: { paths: T3Paths; app: AppStatus } | null = null;
      for (const home of ordered) {
        const paths = resolveT3Paths({ home });
        const app = await detectApp({ paths });
        if (app.running) {
          found = { paths, app };
          break;
        }
        if (home === this.#paths.home) this.#app = app;
      }
      if (found && found.paths.home !== this.#paths.home) {
        this.log.info(`following T3 Code at ${found.paths.home}`);
        this.closeDb();
        this.#usage = null;
        this.#paths = found.paths;
      }
      if (found) this.#app = found.app;
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
  #shownMood = "";
  #shownAt = 0;
  #candidate = "";
  #candidateSince = 0;

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
        if (!settled && !URGENT.test(mood) && this.#shownMood !== "") return;
        this.#shownMood = mood;
        this.#shownAt = now;
      }
      this.presence.set(f.activity);
      this.#logMood(mood);
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
