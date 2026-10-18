import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clampText, sanitizeActivity } from "../src/discord/activity.ts";
import { DiscordIpc } from "../src/discord/ipc.ts";
import { PresenceClient } from "../src/discord/presence.ts";

function frame(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const h = Buffer.alloc(8);
  h.writeUInt32LE(op, 0);
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}

interface Fake {
  path: string;
  server: Server;
  sockets: Socket[];
  activities: Array<unknown>;
  received: Array<{ op: number; msg: any }>;
  /** Reply behavior override for SET_ACTIVITY. */
  reply?: (sock: Socket, msg: any) => void;
  split?: boolean;
  close(): Promise<void>;
}

async function fakeDiscord(): Promise<Fake> {
  const dir = mkdtempSync(join(tmpdir(), "t3rpc-ipc-"));
  const path = join(dir, "discord-ipc-0");
  const fake = { path, sockets: [], activities: [], received: [] } as unknown as Fake;
  const write = (sock: Socket, buf: Buffer) => {
    if (fake.split) {
      // header and body in separate, delayed writes
      sock.write(buf.subarray(0, 5));
      setTimeout(() => sock.write(buf.subarray(5)), 5);
    } else sock.write(buf);
  };
  fake.server = createServer((sock) => {
    fake.sockets.push(sock);
    let buf = Buffer.alloc(0);
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readUInt32LE(0);
        const len = buf.readUInt32LE(4);
        if (buf.length < 8 + len) break;
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString());
        buf = buf.subarray(8 + len);
        fake.received.push({ op, msg });
        if (op === 0) write(sock, frame(1, { cmd: "DISPATCH", evt: "READY", data: { user: { id: "1", username: "tester" } } }));
        if (op === 1 && msg.cmd === "SET_ACTIVITY") {
          if (fake.reply) fake.reply(sock, msg);
          else {
            fake.activities.push(msg.args.activity);
            write(sock, frame(1, { cmd: "SET_ACTIVITY", data: msg.args.activity, nonce: msg.nonce }));
          }
        }
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => fake.server.listen(path, r));
  fake.close = () =>
    new Promise((r) => {
      for (const s of fake.sockets) s.destroy();
      fake.server.close(() => r());
    });
  return fake;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("clampText keeps surrogate pairs and Discord's 2-char minimum", () => {
  assert.equal(clampText("a"), "a ");
  assert.equal(clampText("   "), undefined);
  const long = "🪄".repeat(200);
  const out = clampText(long)!;
  assert.equal([...out].length, 128);
  assert.ok(out.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF]$/.test(out.slice(0, -1)));
});

test("sanitizeActivity drops bad buttons and empty fields", () => {
  const a = sanitizeActivity({
    details: "  hi there ",
    state: "",
    buttons: [
      { label: "ok", url: "https://a.b" },
      { label: "bad", url: "javascript:alert(1)" },
      { label: "two", url: "https://c.d" },
      { label: "three", url: "https://e.f" },
    ],
    assets: { large_image: "https://x/y.gif", large_text: "" },
  });
  assert.equal(a.details, "hi there");
  assert.equal(a.state, undefined);
  assert.deepEqual(a.buttons?.map((b) => b.label), ["ok", "two"]);
  assert.deepEqual(a.assets, { large_image: "https://x/y.gif" });
});

test("ipc: handshake, fragmented frames, nonce replies, errors, ping", async () => {
  const fake = await fakeDiscord();
  fake.split = true;
  const ipc = new DiscordIpc({ clientId: "123", socketPaths: () => [fake.path] });
  const user = await ipc.connect();
  assert.equal(user.username, "tester");
  assert.deepEqual(fake.received[0], { op: 0, msg: { v: 1, client_id: "123" } });
  await ipc.setActivity({ details: "hello" });
  assert.deepEqual(fake.activities, [{ details: "hello" }]);

  // two frames coalesced into one write, plus a PING
  fake.reply = (sock, msg) => {
    sock.write(Buffer.concat([frame(3, { x: 1 }), frame(1, { cmd: "SET_ACTIVITY", evt: "ERROR", data: { message: "nope" }, nonce: msg.nonce })]));
  };
  await assert.rejects(ipc.setActivity({ details: "x" }), /nope/);
  await sleep(20);
  assert.ok(fake.received.some((r) => r.op === 4 && r.msg.x === 1), "pong sent");
  ipc.close();
  await fake.close();
});

test("ipc: rejects when no socket exists", async () => {
  const ipc = new DiscordIpc({ clientId: "1", socketPaths: () => ["/nonexistent/discord-ipc-0"] });
  await assert.rejects(ipc.connect(), /not found/);
});

test("presence: coalesces bursts, skips unchanged, honors min gap", async () => {
  const fake = await fakeDiscord();
  const client = new PresenceClient({ clientId: "1", socketPaths: () => [fake.path], minGapMs: 500, windowMs: 5000, maxWritesPerWindow: 10 });
  client.start();
  client.set({ details: "one" });
  client.set({ details: "two" });
  client.set({ details: "three" });
  await sleep(100);
  assert.deepEqual(fake.activities, [{ details: "three" }]);
  client.set({ details: "three" });
  await sleep(50);
  assert.equal(fake.activities.length, 1, "unchanged payload skipped");
  client.set({ details: "four" });
  await sleep(40);
  assert.equal(fake.activities.length, 1, "min gap holds the write");
  await sleep(500);
  assert.deepEqual(fake.activities.at(-1), { details: "four" });
  await client.stop();
  assert.equal(fake.activities.at(-1), null, "stop clears the activity");
  await fake.close();
});

test("presence: sliding window cap", async () => {
  const fake = await fakeDiscord();
  const client = new PresenceClient({ clientId: "1", socketPaths: () => [fake.path], minGapMs: 10, windowMs: 400, maxWritesPerWindow: 2 });
  client.start();
  await sleep(50);
  for (let i = 0; i < 5; i++) {
    client.set({ details: `n${i}` });
    await sleep(30);
  }
  assert.equal(fake.activities.length, 2, "only two writes in the window");
  await sleep(450);
  assert.deepEqual(fake.activities.at(-1), { details: "n4" }, "latest payload lands after the window");
  await client.stop();
  await fake.close();
});

test("presence: reconnects and replays the desired activity", async () => {
  const fake = await fakeDiscord();
  const client = new PresenceClient({ clientId: "1", socketPaths: () => [fake.path], minGapMs: 10, baseBackoffMs: 50 });
  client.start();
  client.set({ details: "keep me" });
  await sleep(80);
  assert.equal(fake.activities.length, 1);
  for (const s of fake.sockets) s.destroy();
  await sleep(250);
  assert.ok(client.status().connected, "reconnected");
  assert.equal(fake.activities.length, 2, "replayed after reconnect");
  assert.deepEqual(fake.activities[1], { details: "keep me" });
  await client.stop();
  await fake.close();
});
