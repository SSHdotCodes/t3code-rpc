// Keeps one desired activity in sync with Discord: reconnects with jittered
// backoff, coalesces bursts to the latest payload, skips unchanged payloads,
// and stays well under Discord's presence rate limit (min gap + sliding window).
import { activityKey, sanitizeActivity } from "./activity.js";
import { DiscordIpc } from "./ipc.js";
const quiet = { debug() { }, info() { }, warn() { } };
export class PresenceClient {
    #o;
    #log;
    #factory;
    #socketPaths;
    #ipc = null;
    #connected = false;
    #user = null;
    /** undefined = nothing requested yet */
    #desired = undefined;
    #appliedKey = "null";
    #lastAppliedAt = null;
    #writes = [];
    #lastWriteAt = 0;
    #flushTimer = null;
    #flushAt = 0;
    #flushing = false;
    #reconnectTimer = null;
    #reassertTimer = null;
    #backoff;
    #lastError = null;
    #stopped = false;
    #started = false;
    constructor(opts) {
        this.#o = {
            clientId: opts.clientId,
            minGapMs: opts.minGapMs ?? 4000,
            windowMs: opts.windowMs ?? 20_000,
            maxWritesPerWindow: opts.maxWritesPerWindow ?? 4,
            reassertMs: opts.reassertMs ?? 60_000,
            baseBackoffMs: opts.baseBackoffMs ?? 5000,
            maxBackoffMs: opts.maxBackoffMs ?? 300_000,
        };
        this.#log = opts.logger ?? quiet;
        this.#factory = opts.ipcFactory ?? ((o) => new DiscordIpc(o));
        this.#socketPaths = opts.socketPaths;
        this.#backoff = this.#o.baseBackoffMs;
    }
    start() {
        if (this.#started)
            return;
        this.#started = true;
        this.#stopped = false;
        void this.#connect();
        this.#reassertTimer = setInterval(() => this.#reassert(), Math.max(1000, Math.min(this.#o.reassertMs, 15_000)));
        this.#reassertTimer.unref?.();
    }
    /** Desired activity (null clears). Never throws; applied as soon as limits allow. */
    set(activity) {
        this.#desired = activity === null ? null : sanitizeActivity(activity);
        this.#schedule(0);
    }
    status() {
        const now = Date.now();
        return {
            connected: this.#connected,
            user: this.#user,
            lastError: this.#lastError,
            lastAppliedAt: this.#lastAppliedAt,
            writesInWindow: this.#writes.filter((t) => now - t < this.#o.windowMs).length,
        };
    }
    async stop() {
        this.#stopped = true;
        this.#started = false;
        for (const t of [this.#flushTimer, this.#reconnectTimer])
            if (t)
                clearTimeout(t);
        if (this.#reassertTimer)
            clearInterval(this.#reassertTimer);
        this.#flushTimer = this.#reconnectTimer = this.#reassertTimer = null;
        const ipc = this.#ipc;
        if (ipc && this.#connected && this.#appliedKey !== "null") {
            await Promise.race([ipc.setActivity(null).catch(() => { }), new Promise((r) => setTimeout(r, 2000))]);
        }
        ipc?.close("stopped");
        this.#ipc = null;
        this.#connected = false;
    }
    // -------------------------------------------------------------------------
    async #connect() {
        if (this.#stopped)
            return;
        const ipc = this.#factory({ clientId: this.#o.clientId, socketPaths: this.#socketPaths });
        this.#ipc = ipc;
        ipc.once("close", (reason) => {
            if (this.#ipc !== ipc)
                return;
            const wasConnected = this.#connected;
            this.#connected = false;
            this.#ipc = null;
            if (wasConnected && !this.#stopped)
                this.#log.warn(`discord: disconnected (${reason})`);
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
            // A fresh connection shows nothing until we set something.
            this.#appliedKey = "null";
            this.#log.info(`discord: connected${user ? ` as ${user.username}` : ""}`);
            this.#schedule(0);
        }
        catch (err) {
            this.#lastError = err.message;
            this.#log.debug(`discord: connect failed: ${this.#lastError}`);
            if (this.#ipc === ipc) {
                this.#ipc = null;
                ipc.close("connect failed");
            }
        }
    }
    #scheduleReconnect() {
        if (this.#stopped || this.#reconnectTimer)
            return;
        const delay = Math.round(this.#backoff * (0.7 + Math.random() * 0.6));
        this.#backoff = Math.min(this.#backoff * 2, this.#o.maxBackoffMs);
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            void this.#connect();
        }, delay);
        this.#reconnectTimer.unref?.();
    }
    #schedule(delay) {
        if (this.#stopped)
            return;
        const at = Date.now() + delay;
        if (this.#flushTimer && this.#flushAt <= at)
            return;
        if (this.#flushTimer)
            clearTimeout(this.#flushTimer);
        this.#flushAt = at;
        this.#flushTimer = setTimeout(() => {
            this.#flushTimer = null;
            void this.#flush();
        }, delay);
    }
    async #flush() {
        if (this.#flushing || !this.#connected || this.#desired === undefined)
            return;
        const desired = this.#desired;
        const key = activityKey(desired);
        if (key === this.#appliedKey)
            return;
        const now = Date.now();
        this.#writes = this.#writes.filter((t) => now - t < this.#o.windowMs);
        const gapWait = this.#lastWriteAt + this.#o.minGapMs - now;
        const windowWait = this.#writes.length >= this.#o.maxWritesPerWindow ? this.#writes[0] + this.#o.windowMs - now : 0;
        const wait = Math.max(gapWait, windowWait);
        if (wait > 0) {
            this.#schedule(wait);
            return;
        }
        const ipc = this.#ipc;
        if (!ipc)
            return;
        this.#flushing = true;
        this.#writes.push(now);
        this.#lastWriteAt = now;
        try {
            await ipc.setActivity(desired);
            this.#appliedKey = key;
            this.#lastAppliedAt = Date.now();
            this.#log.debug(`discord: applied ${desired ? desired.details ?? "activity" : "clear"}`);
        }
        catch (err) {
            this.#lastError = err.message;
            this.#log.warn(`discord: SET_ACTIVITY failed: ${this.#lastError}`);
            // Timeouts and broken pipes mean the connection is unhealthy; rebuild it.
            if (/timed out|closed|not connected|EPIPE/i.test(this.#lastError))
                ipc.close(this.#lastError);
        }
        finally {
            this.#flushing = false;
        }
        if (activityKey(this.#desired ?? null) !== this.#appliedKey)
            this.#schedule(0);
    }
    /** Some clients/bridges drop activities on reconnect; re-send an unchanged non-null one now and then. */
    #reassert() {
        if (!this.#connected || !this.#desired || this.#lastAppliedAt === null)
            return;
        if (Date.now() - this.#lastAppliedAt < this.#o.reassertMs)
            return;
        this.#appliedKey = "";
        this.#schedule(0);
    }
}
