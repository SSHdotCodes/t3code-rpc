// Minimal Discord RPC client over the local IPC socket/pipe.
// Frame: uint32 LE opcode, uint32 LE byte length, UTF-8 JSON.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;
/** Every place a Discord client (stable, canary, flatpak, snap, Vesktop) may expose its socket. */
export function defaultSocketPaths() {
    if (process.platform === "win32")
        return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
    const env = process.env;
    const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, tmpdir(), "/tmp"].filter((b) => !!b);
    const subs = [
        "",
        "app/com.discordapp.Discord",
        "app/com.discordapp.DiscordCanary",
        "snap.discord",
        "snap.discord-canary",
        ".flatpak/dev.vencord.Vesktop/xdg-run",
        ".flatpak/com.discordapp.Discord/xdg-run",
    ];
    const seen = new Set();
    const out = [];
    for (const base of bases)
        for (const sub of subs)
            for (let i = 0; i < 10; i++) {
                const p = join(base, sub, `discord-ipc-${i}`);
                if (!seen.has(p)) {
                    seen.add(p);
                    out.push(p);
                }
            }
    return out;
}
function encode(op, payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
}
/**
 * One connection. Emits "ready" (user) and "close" (reason) exactly once.
 * Create a new instance to reconnect.
 */
export class DiscordIpc extends EventEmitter {
    #opts;
    #socket = null;
    #buffer = Buffer.alloc(0);
    #pending = new Map();
    #closed = false;
    user = null;
    constructor(opts) {
        super();
        this.#opts = opts;
    }
    async connect() {
        const candidates = (this.#opts.socketPaths ?? defaultSocketPaths)().filter((p) => process.platform === "win32" || existsSync(p));
        if (candidates.length === 0)
            throw new Error("Discord IPC socket not found (is the Discord desktop app running?)");
        let lastError = null;
        for (const path of candidates) {
            try {
                this.#socket = await new Promise((resolve, reject) => {
                    const s = connect(path);
                    s.once("connect", () => {
                        s.off("error", reject);
                        resolve(s);
                    });
                    s.once("error", reject);
                });
                break;
            }
            catch (err) {
                lastError = err;
            }
        }
        const socket = this.#socket;
        if (!socket)
            throw new Error(`could not connect to Discord IPC: ${lastError?.message ?? "unknown error"}`);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("Discord handshake timed out"));
                this.close("handshake timeout");
            }, this.#opts.requestTimeoutMs ?? 10_000);
            const onReady = (user) => {
                clearTimeout(timer);
                this.off("close", onClose);
                resolve(user);
            };
            const onClose = (reason) => {
                clearTimeout(timer);
                this.off("ready", onReady);
                reject(new Error(`Discord closed the connection: ${reason}`));
            };
            this.once("ready", onReady);
            this.once("close", onClose);
            socket.on("data", (chunk) => this.#onData(chunk));
            socket.on("error", (err) => this.close(err.message));
            socket.on("close", () => this.close("socket closed"));
            socket.write(encode(OP_HANDSHAKE, { v: 1, client_id: this.#opts.clientId }));
        });
    }
    #onData(chunk) {
        this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
        while (this.#buffer.length >= 8) {
            const op = this.#buffer.readUInt32LE(0);
            const len = this.#buffer.readUInt32LE(4);
            if (this.#buffer.length < 8 + len)
                break;
            const body = this.#buffer.subarray(8, 8 + len).toString("utf8");
            this.#buffer = this.#buffer.subarray(8 + len);
            let msg;
            try {
                msg = JSON.parse(body);
            }
            catch {
                continue;
            }
            this.#onMessage(op, msg);
        }
    }
    #onMessage(op, msg) {
        if (op === OP_PING) {
            this.#socket?.write(encode(OP_PONG, msg));
            return;
        }
        if (op === OP_CLOSE) {
            this.close(msg?.message ?? `closed (${msg?.code ?? "?"})`);
            return;
        }
        if (op !== OP_FRAME)
            return;
        if (msg?.cmd === "DISPATCH" && msg?.evt === "READY") {
            const u = msg.data?.user;
            this.user = u ? { id: String(u.id), username: String(u.global_name || u.username) } : null;
            this.emit("ready", this.user);
            return;
        }
        const pending = msg?.nonce ? this.#pending.get(msg.nonce) : undefined;
        if (!pending)
            return;
        this.#pending.delete(msg.nonce);
        clearTimeout(pending.timer);
        if (msg.evt === "ERROR")
            pending.reject(new Error(msg.data?.message ?? "Discord returned an error"));
        else
            pending.resolve(msg.data);
    }
    request(cmd, args) {
        const socket = this.#socket;
        if (!socket || this.#closed)
            return Promise.reject(new Error("not connected"));
        const nonce = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(nonce);
                reject(new Error(`${cmd} timed out`));
            }, this.#opts.requestTimeoutMs ?? 10_000);
            this.#pending.set(nonce, { resolve, reject, timer });
            socket.write(encode(OP_FRAME, { cmd, args, nonce }));
        });
    }
    setActivity(activity) {
        return this.request("SET_ACTIVITY", { pid: process.pid, activity });
    }
    close(reason = "closed") {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const p of this.#pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error(`connection closed: ${reason}`));
        }
        this.#pending.clear();
        const s = this.#socket;
        this.#socket = null;
        s?.removeAllListeners("data");
        s?.on("error", () => { });
        s?.destroy();
        this.emit("close", reason);
    }
    get closed() {
        return this.#closed;
    }
}
