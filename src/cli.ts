#!/usr/bin/env node
// t3code-rpc — Discord Rich Presence for T3 Code.

import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { activityUrl, badgeUrl } from "./art/catalog.ts";
import { configPath, DEFAULT_CONFIG, loadConfig, readUserConfig, rpcHome, setConfigValue } from "./config.ts";
import { Daemon, makeLogger, Observer } from "./daemon.ts";
import type { DiscordActivity } from "./discord/activity.ts";
import { PresenceClient } from "./discord/presence.ts";
import { formatTokens, windowLabel } from "./presence/format.ts";
import { CHARACTER_KINDS, type CharacterKind } from "./render/characters.ts";
import { ACTIVITY_SCENES } from "./render/scenes.ts";
import { T3Database } from "./t3/db.ts";
import { readUsage } from "./t3/usage.ts";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "t3code-rpc.js");
const LABEL = "codes.ssh.t3code-rpc";
const pidFile = () => join(rpcHome(), "daemon.pid");
const logFile = () => join(rpcHome(), "daemon.log");

const HELP = `t3code-rpc — Discord Rich Presence for T3 Code

Usage: t3code-rpc <command> [options]

  run                 Run the daemon in the foreground
  start               Start in the background (uses the login service if installed)
  stop                Stop the background daemon and clear the presence
  restart             Stop, then start
  status              Show what T3 Code is doing and what Discord would show
  preview [--watch]   Print the activity payload without touching Discord
  demo <scene>        Show a scene on Discord for a minute, e.g.
                        demo thinking --as codex
                        demo orbit --as claude --with codex,codex,grok
                      scenes: ${ACTIVITY_SCENES.join(", ")}, orbit
  usage [--days N]    Token usage from T3 Code (default: configured window)
  doctor              Check Discord, T3 Code, art hosting and rendering tools
  install             Start automatically at login (launchd / systemd / Startup folder)
  uninstall           Remove the login service and clear the presence
  config [path|get [key]|set <key> <value>]
                      e.g. config set tokens.windowDays 7
  logs [-f]           Show the daemon log
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// service management
// ---------------------------------------------------------------------------

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", "t3code-rpc.service");
const startupPath = () => join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "t3code-rpc.vbs");

function serviceInstalled(): boolean {
  const p = platform();
  if (p === "darwin") return existsSync(plistPath());
  if (p === "linux") return existsSync(unitPath());
  if (p === "win32") return existsSync(startupPath());
  return false;
}

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function install(): Promise<void> {
  mkdirSync(rpcHome(), { recursive: true });
  const node = process.execPath;
  const p = platform();
  const pathEnv = [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  if (p === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(BIN)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathEnv)}</string></dict>
  <key>StandardOutPath</key><string>${xml(logFile())}</string>
  <key>StandardErrorPath</key><string>${xml(logFile())}</string>
</dict>
</plist>
`;
    mkdirSync(dirname(plistPath()), { recursive: true });
    const uid = process.getuid?.() ?? 501;
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {});
    writeFileSync(plistPath(), plist);
    await run("launchctl", ["bootstrap", `gui/${uid}`, plistPath()]);
    console.log(`Installed ${plistPath()} — t3code-rpc now starts at login and is running.`);
  } else if (p === "linux") {
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(
      unitPath(),
      `[Unit]\nDescription=T3 Code Discord Rich Presence\nAfter=graphical-session.target\n\n[Service]\nExecStart=${node} ${BIN} run\nRestart=on-failure\nRestartSec=10\nEnvironment=PATH=${pathEnv}\n\n[Install]\nWantedBy=default.target\n`,
    );
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "--now", "t3code-rpc.service"]);
    console.log(`Installed ${unitPath()} and started it.`);
  } else if (p === "win32") {
    mkdirSync(dirname(startupPath()), { recursive: true });
    const cmd = `"""${node}"" ""${BIN}"" run"`;
    writeFileSync(startupPath(), `CreateObject("WScript.Shell").Run ${cmd}, 0, False\r\n`);
    await start();
    console.log(`Installed ${startupPath()} — t3code-rpc starts at login.`);
  } else {
    throw new Error(`Autostart isn't supported on ${p}; run \`t3code-rpc start\` instead.`);
  }
}

async function uninstall(): Promise<void> {
  const p = platform();
  await stop();
  if (p === "darwin" && existsSync(plistPath())) rmSync(plistPath());
  if (p === "linux" && existsSync(unitPath())) {
    await run("systemctl", ["--user", "disable", "--now", "t3code-rpc.service"]).catch(() => {});
    rmSync(unitPath());
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
  }
  if (p === "win32" && existsSync(startupPath())) rmSync(startupPath());
  console.log("Removed the login service. Config and logs remain in " + rpcHome());
}

async function start(): Promise<void> {
  if (serviceInstalled() && platform() === "darwin") {
    const uid = process.getuid?.() ?? 501;
    await run("launchctl", ["bootstrap", `gui/${uid}`, plistPath()]).catch(() => {});
    await run("launchctl", ["kickstart", `gui/${uid}/${LABEL}`]).catch(() => {});
    console.log("Started (launchd).");
    return;
  }
  if (serviceInstalled() && platform() === "linux") {
    await run("systemctl", ["--user", "start", "t3code-rpc.service"]);
    console.log("Started (systemd).");
    return;
  }
  const existing = readPid();
  if (existing) {
    console.log(`Already running (pid ${existing}).`);
    return;
  }
  mkdirSync(rpcHome(), { recursive: true });
  const out = openSync(logFile(), "a");
  const child = spawn(process.execPath, [BIN, "run"], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
  closeSync(out);
  console.log(`Started in the background (pid ${child.pid}). Logs: ${logFile()}`);
}

async function stop(): Promise<void> {
  if (platform() === "darwin" && serviceInstalled()) {
    const uid = process.getuid?.() ?? 501;
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {});
  }
  if (platform() === "linux" && serviceInstalled()) await run("systemctl", ["--user", "stop", "t3code-rpc.service"]).catch(() => {});
  const pid = readPid();
  if (pid && pid !== process.pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 30 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(pidFile(), { force: true });
  console.log("Stopped.");
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function runForeground(): Promise<void> {
  const other = readPid();
  if (other && other !== process.pid) {
    console.error(`t3code-rpc is already running (pid ${other}). Use \`t3code-rpc stop\` first.`);
    process.exit(1);
  }
  mkdirSync(rpcHome(), { recursive: true });
  writeFileSync(pidFile(), String(process.pid));
  const daemon = new Daemon(loadConfig(), makeLogger());
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await daemon.stop().catch(() => {});
    rmSync(pidFile(), { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  await daemon.start();
}

function describe(activity: DiscordActivity | null): string {
  if (!activity) return "  (presence cleared)";
  return [
    `  ${activity.name ?? "T3 Code"}`,
    `  ${activity.details ?? ""}`,
    `  ${activity.state ?? ""}`,
    `  art:   ${activity.assets?.large_image}`,
    `  badge: ${activity.assets?.small_image}`,
    `  hover: ${activity.assets?.large_text} | ${activity.assets?.small_text}`,
  ].join("\n");
}

async function status(): Promise<void> {
  const cfg = loadConfig();
  const obs = new Observer(cfg, makeLogger(), { dynamic: false });
  const f = await obs.frame();
  const pid = readPid();
  console.log(`daemon:   ${pid ? `running (pid ${pid})` : "not running"}${serviceInstalled() ? " · login service installed" : ""}`);
  console.log(`T3 Code:  ${f.app.running ? `open (server ${f.app.serverVersion ?? "?"}, port ${f.app.port})` : "closed"}`);
  if (f.snapshot) {
    const kids = f.snapshot.threads.reduce((n, t) => n + t.children.length, 0);
    const busy = f.snapshot.threads.reduce((n, t) => n + t.children.filter((c) => c.state !== "outstanding").length, 0);
    console.log(`activity: ${f.snapshot.threads.length} active thread(s), ${kids} subagent(s) pending (${busy} working right now)`);
  }
  if (f.usage) console.log(`tokens:   ${formatTokens(f.usage.totals.total)} (${windowLabel(f.usage.windowDays)}, ${f.usage.totals.turns} turns)`);
  console.log(`\nDiscord would show (${f.decision?.mood ?? "nothing"}):\n${describe(f.activity)}`);
  obs.closeDb();
}

async function preview(watch: boolean): Promise<void> {
  const obs = new Observer(loadConfig(), makeLogger(), { dynamic: false });
  do {
    const f = await obs.frame();
    console.log(JSON.stringify({ mood: f.decision?.mood ?? null, activity: f.activity }, null, 2));
    if (watch) await new Promise((r) => setTimeout(r, 2000));
  } while (watch);
  obs.closeDb();
}

async function demo(scene: string | undefined, as: string | undefined, withList: string | undefined, seconds: number): Promise<void> {
  const cfg = loadConfig();
  const kind = (as ?? "t3") as CharacterKind;
  if (!CHARACTER_KINDS.includes(kind)) throw new Error(`--as must be one of: ${CHARACTER_KINDS.join(", ")}`);
  const { buildActivity } = await import("./presence/activity.ts");
  const obs = new Observer(cfg, makeLogger());
  let activity: DiscordActivity;
  if (scene === "orbit") {
    const orbiters = (withList ?? "codex,codex,grok").split(",").map((s) => s.trim()) as CharacterKind[];
    for (const o of orbiters) if (!CHARACTER_KINDS.includes(o)) throw new Error(`unknown logo: ${o}`);
    const decision = {
      art: { kind: "orbit" as const, conductor: kind, orbiters, count: orbiters.length },
      details: `🪄 Orchestrating ${orbiters.length} agents`,
      stateLines: ["Demo mode"],
      largeText: "t3code-rpc demo",
      badge: kind,
      smallText: "t3code-rpc demo",
      startedAt: Date.now(),
      mood: "demo",
    };
    activity = buildActivity(cfg, decision, obs.dynamic);
    if (obs.dynamic) {
      // give the exact ring a moment to render and publish
      for (let i = 0; i < 30; i++) {
        const next = buildActivity(cfg, decision, obs.dynamic);
        if (next.assets?.large_image !== activity.assets?.large_image) {
          activity = next;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } else {
    const s = (scene ?? "thinking") as (typeof ACTIVITY_SCENES)[number];
    if (!ACTIVITY_SCENES.includes(s)) throw new Error(`scene must be one of: ${ACTIVITY_SCENES.join(", ")}, orbit`);
    activity = {
      name: cfg.appName,
      type: cfg.activityType,
      details: `Demo · ${s}`,
      state: "t3code-rpc",
      timestamps: { start: Date.now() },
      assets: { large_image: activityUrl(cfg.art, s, kind), large_text: `${kind} · ${s}`, small_image: badgeUrl(cfg.art, kind), small_text: kind },
      buttons: cfg.buttons.slice(0, 2),
    };
  }
  console.log(describe(activity));
  const client = new PresenceClient({ clientId: cfg.clientId, logger: makeLogger() });
  client.start();
  client.set(activity);
  console.log(`\nShowing on Discord for ${seconds}s (Ctrl+C to stop)…`);
  const done = async () => {
    await client.stop();
    process.exit(0);
  };
  process.on("SIGINT", done);
  setTimeout(done, seconds * 1000);
}

async function usage(days: number | undefined): Promise<void> {
  const cfg = loadConfig();
  const obs = new Observer(cfg, makeLogger(), { dynamic: false });
  const db = new T3Database(obs.paths.dbPath);
  try {
    const u = readUsage(db, { windowDays: days ?? cfg.tokens.windowDays });
    const row = (name: string, t: typeof u.totals) =>
      `${name.padEnd(14)} ${formatTokens(t.total).padStart(8)} total  ${formatTokens(t.input).padStart(8)} in (${formatTokens(t.cachedInput)} cached)  ${formatTokens(t.output).padStart(7)} out  ${String(t.turns).padStart(5)} turns`;
    console.log(`T3 Code token usage, ${windowLabel(u.windowDays)}\n`);
    for (const [driver, t] of Object.entries(u.byDriver).sort((a, b) => b[1].total - a[1].total)) console.log(row(driver, t));
    console.log("-".repeat(80));
    console.log(row("all", u.totals));
  } finally {
    db.close();
  }
}

async function doctor(): Promise<void> {
  const cfg = loadConfig();
  const ok = (good: boolean, label: string, detail = "") => console.log(`${good ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  ok(major > 22 || (major === 22 && minor >= 18), "Node.js", process.versions.node);
  ok(existsSync(configPath()) || true, "config", existsSync(configPath()) ? configPath() : "defaults (no config file yet)");
  ok(cfg.clientId !== "", "Discord application", cfg.clientId);
  const obs = new Observer(cfg, makeLogger(), { dynamic: false });
  const app = await obs.app();
  ok(!!app.dbPath, "T3 Code data", app.dbPath ?? `not found under ${obs.paths.home}`);
  ok(app.running, "T3 Code running", app.running ? `server ${app.serverVersion} on port ${app.port}` : "not running (presence stays clear)");
  if (app.dbPath) {
    const db = new T3Database(app.dbPath);
    ok(db.hasV2, "T3 Code schema", db.hasV2 ? "orchestration v2" : "unsupported/old schema");
    db.close();
  }
  // Discord: try a handshake
  const client = new PresenceClient({ clientId: cfg.clientId });
  client.start();
  let connected = false;
  for (let i = 0; i < 30 && !connected; i++) {
    await new Promise((r) => setTimeout(r, 100));
    connected = client.status().connected;
  }
  const st = client.status();
  ok(connected, "Discord", connected ? `connected as ${st.user?.username ?? "?"}` : `not reachable${st.lastError ? ` (${st.lastError})` : ""} — is the desktop app open?`);
  await client.stop();
  // Art hosting
  const sample = activityUrl(cfg.art, "idle", "t3");
  const head = await fetch(sample, { method: "HEAD", signal: AbortSignal.timeout(8000) }).catch((e: Error) => e);
  ok(!(head instanceof Error) && head.ok, "Art hosting", head instanceof Error ? head.message : `${head.status} ${sample}`);
  // Dynamic rings
  if (cfg.art.dynamic.enabled) {
    const { hasFfmpeg } = await import("./render/encode.ts");
    ok(await hasFfmpeg(), "ffmpeg (exact orchestration rings)");
    let resvg = true;
    try {
      await import("@resvg/resvg-js");
    } catch {
      resvg = false;
    }
    ok(resvg, "@resvg/resvg-js (exact orchestration rings)");
    const gh = await run("gh", ["auth", "status"]).then(
      () => true,
      () => !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
    );
    ok(gh, "GitHub auth", `publishing rings to ${cfg.art.dynamic.githubRepo}@${cfg.art.dynamic.branch}`);
  } else {
    console.log("· exact orchestration rings off (art.dynamic.enabled = false) — pre-rendered rings are used");
  }
  ok(true, "daemon", readPid() ? `running (pid ${readPid()})` : "not running");
  process.exit(0);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      watch: { type: "boolean", short: "w" },
      follow: { type: "boolean", short: "f" },
      days: { type: "string" },
      as: { type: "string" },
      with: { type: "string" },
      seconds: { type: "string", default: "60" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd || cmd === "help") {
    console.log(HELP);
    return;
  }
  switch (cmd) {
    case "run":
      return runForeground();
    case "start":
      return start();
    case "stop":
      return stop();
    case "restart":
      await stop();
      return start();
    case "status":
      return status();
    case "preview":
      return preview(!!values.watch);
    case "demo":
      return demo(rest[0], values.as, values.with, Number(values.seconds));
    case "usage":
      return usage(values.days !== undefined ? Number(values.days) : undefined);
    case "doctor":
      return doctor();
    case "install":
      return install();
    case "uninstall":
      return uninstall();
    case "logs": {
      if (!existsSync(logFile())) return console.log("No log yet.");
      if (values.follow) {
        spawn("tail", ["-n", "50", "-f", logFile()], { stdio: "inherit" });
        return;
      }
      console.log(readFileSync(logFile(), "utf8").split("\n").slice(-60).join("\n"));
      return;
    }
    case "config": {
      const [sub, key, value] = rest;
      if (!sub || sub === "path") return console.log(configPath());
      if (sub === "get") {
        const cfg = loadConfig() as unknown as Record<string, unknown>;
        const v = key ? key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], cfg) : cfg;
        return console.log(JSON.stringify(v, null, 2));
      }
      if (sub === "set" && key && value !== undefined) {
        setConfigValue(key, value);
        console.log(`Set ${key}. Restart to apply: t3code-rpc restart`);
        return;
      }
      if (sub === "defaults") return console.log(JSON.stringify(DEFAULT_CONFIG, null, 2));
      if (sub === "show") return console.log(JSON.stringify(readUserConfig(), null, 2));
      throw new Error("usage: t3code-rpc config [path|get [key]|set <key> <value>|defaults|show]");
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`t3code-rpc: ${(err as Error).message}`);
  process.exit(1);
});
