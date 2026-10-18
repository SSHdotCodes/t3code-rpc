// Keeps one desired activity in sync with Discord: reconnects with jittered
// backoff, coalesces bursts to the latest payload, skips unchanged payloads,
// and stays well under Discord's presence rate limit (min gap + sliding window).

import { activityKey, type DiscordActivity, sanitizeActivity } from "./activity.ts";
import { DiscordIpc, type DiscordIpcOptions, type DiscordUser } from "./ipc.ts";

export interface PresenceLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
}

export interface PresenceClientOptions {
  clientId: string;
  logger?: PresenceLogger;
  minGapMs?: number;
  windowMs?: number;
  maxWritesPerWindow?: number;
  reassertMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  ipcFactory?: (opts: DiscordIpcOptions) => DiscordIpc;
  socketPaths?: () => string[];
}

export interface PresenceStatus {
  connected: boolean;
  user: DiscordUser | null;
  lastError: string | null;
  lastAppliedAt: number | null;
  writesInWindow: number;
}

const quiet: PresenceLogger = { debug() {}, info() {}, warn() {} };

export class PresenceClient {
  readonly #o: Required<Omit<PresenceClientOptions, "ipcFactory" | "socketPaths" | "logger">>;
  readonly #log: PresenceLogger;
  readonly #factory: (opts: DiscordIpcOptions) => DiscordIpc;
  readonly #socketPaths?: () => string[];
  #ipc: DiscordIpc | null = null;
  #connected = false;
  #user: DiscordUser | null = null;
  /** undefined = nothing requested yet */
  #desired: DiscordActivity | null | undefined = undefined;
  #appliedKey = "null";
  #lastAppliedAt: number | null = null;
  #writes: number[] = [];
  #lastWriteAt = 0;
  #flushTimer: NodeJS.Timeout | null = null;
  #flushAt = 0;
  #flushing = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reassertTimer: NodeJS.Timeout | null = null;
  #backoff: number;
  #lastError: string | null = null;
  #stopped = false;
  #started = false;
  #announcedWaiting = false;

  constructor(opts: PresenceClientOptions) {
    this.#o = {
      clientId: opts.clientId,
      minGapMs: opts.minGapMs ?? 4000,
      windowMs: opts.windowMs ?? 20_000,
      maxWritesPerWindow: opts.maxWritesPerWindow ?? 4,
      reassertMs: opts.reassertMs ?? 60_000,
      baseBackoffMs: opts.baseBackoffMs ?? 5000,
      maxBackoffMs: opts.maxBackoffMs ?? 60_000,
    };
    this.#log = opts.logger ?? quiet;
    this.#factory = opts.ipcFactory ?? ((o) => new DiscordIpc(o));
    this.#socketPaths = opts.socketPaths;
    this.#backoff = this.#o.baseBackoffMs;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    void this.#connect();
    this.#reassertTimer = setInterval(() => this.#reassert(), Math.max(1000, Math.min(this.#o.reassertMs, 15_000)));
    this.#reassertTimer.unref?.();
  }

  /** Desired activity (null clears). Never throws; applied as soon as limits allow. */
  set(activity: DiscordActivity | null): void {
    this.#desired = activity === null ? null : sanitizeActivity(activity);
    this.#schedule(0);
  }

  status(): PresenceStatus {
    const now = Date.now();
    return {
      connected: this.#connected,
      user: this.#user,
      lastError: this.#lastError,
      lastAppliedAt: this.#lastAppliedAt,
      writesInWindow: this.#writes.filter((t) => now - t < this.#o.windowMs).length,
    };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#started = false;
    for (const t of [this.#flushTimer, this.#reconnectTimer]) if (t) clearTimeout(t);
    if (this.#reassertTimer) clearInterval(this.#reassertTimer);
    this.#flushTimer = this.#reconnectTimer = this.#reassertTimer = null;
    const ipc = this.#ipc;
    if (ipc && this.#connected && this.#appliedKey !== "null") {
      await Promise.race([ipc.setActivity(null).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    }
    ipc?.close("stopped");
    this.#ipc = null;
    this.#connected = false;
  }

  // -------------------------------------------------------------------------

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const ipc = this.#factory({ clientId: this.#o.clientId, socketPaths: this.#socketPaths });
    this.#ipc = ipc;
    ipc.once("close", (reason: string) => {
      if (this.#ipc !== ipc) return;
      const wasConnected = this.#connected;
      this.#connected = false;
      this.#ipc = null;
      if (wasConnected && !this.#stopped) {
        this.#log.warn(`discord: disconnected (${reason})`);
        this.#backoff = this.#o.baseBackoffMs;
      }
      this.#scheduleReconnect();
    });
    try {
      const user = await ipc.connect();
      if (this.#stopped || this.#ipc !== ipc) {
        ipc.close("superseded");
        return;
      }
      this.#connected = true;
      this.#user = user;
      this.#lastError = null;
      this.#backoff = this.#o.baseBackoffMs;
      this.#announcedWaiting = false;
      // A fresh connection shows nothing until we set something.
      this.#appliedKey = "null";
      this.#log.info(`discord: connected${user ? ` as ${user.username}` : ""}`);
      this.#schedule(0);
    } catch (err) {
      this.#lastError = (err as Error).message;
      if (!this.#announcedWaiting) {
        this.#log.info("discord: waiting for the Discord app (will keep retrying)");
        this.#announcedWaiting = true;
      }
      this.#log.debug(`discord: connect failed: ${this.#lastError}`);
      if (this.#ipc === ipc) {
        this.#ipc = null;
        ipc.close("connect failed");
      }
      // The close handler ignores this (already detached) connection, so retry from here.
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = Math.round(this.#backoff * (0.7 + Math.random() * 0.6));
    this.#backoff = Math.min(this.#backoff * 2, this.#o.maxBackoffMs);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    const at = Date.now() + delay;
    if (this.#flushTimer && this.#flushAt <= at) return;
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushAt = at;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flush();
    }, delay);
  }

  async #flush(): Promise<void> {
    if (this.#flushing || !this.#connected || this.#desired === undefined) return;
    const desired = this.#desired;
    const key = activityKey(desired);
    if (key === this.#appliedKey) return;
    const now = Date.now();
    this.#writes = this.#writes.filter((t) => now - t < this.#o.windowMs);
    const gapWait = this.#lastWriteAt + this.#o.minGapMs - now;
    const windowWait = this.#writes.length >= this.#o.maxWritesPerWindow ? this.#writes[0]! + this.#o.windowMs - now : 0;
    const wait = Math.max(gapWait, windowWait);
    if (wait > 0) {
      this.#schedule(wait);
      return;
    }
    const ipc = this.#ipc;
    if (!ipc) return;
    this.#flushing = true;
    this.#writes.push(now);
    this.#lastWriteAt = now;
    try {
      await ipc.setActivity(desired);
      this.#appliedKey = key;
      this.#lastAppliedAt = Date.now();
      this.#log.debug(`discord: applied ${desired ? desired.details ?? "activity" : "clear"}`);
    } catch (err) {
      this.#lastError = (err as Error).message;
      this.#log.warn(`discord: SET_ACTIVITY failed: ${this.#lastError}`);
      // Timeouts and broken pipes mean the connection is unhealthy; rebuild it.
      if (/timed out|closed|not connected|EPIPE/i.test(this.#lastError)) ipc.close(this.#lastError);
    } finally {
      this.#flushing = false;
    }
    if (activityKey(this.#desired ?? null) !== this.#appliedKey) this.#schedule(0);
  }

  /** Some clients/bridges drop activities on reconnect; re-send an unchanged non-null one now and then. */
  #reassert(): void {
    if (!this.#connected || !this.#desired || this.#lastAppliedAt === null) return;
    if (Date.now() - this.#lastAppliedAt < this.#o.reassertMs) return;
    this.#appliedKey = "";
    this.#schedule(0);
  }
}
