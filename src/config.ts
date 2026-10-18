// Config lives in ~/.t3code-rpc/config.json (override the folder with
// T3CODE_RPC_HOME). Everything is optional; missing keys use the defaults.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CLIENT_ID = "1561158891293646988";
export const REPO = "SSHdotCodes/t3code-rpc";
export const REPO_URL = `https://github.com/${REPO}`;

export interface Button {
  label: string;
  url: string;
}

export interface Config {
  /** Discord application id. The app's name ("T3 Code") is the card title. */
  clientId: string;
  /** Activity name override shown as the card title / "Playing …". */
  appName: string;
  /** 0 Playing, 2 Listening, 3 Watching, 5 Competing. */
  activityType: 0 | 2 | 3 | 5;
  /** What the member list shows next to your name: the app name, the details line or the state line. */
  statusDisplay: "name" | "details" | "state";
  tokens: {
    show: boolean;
    /** Trailing window in days; 0 = all time. */
    windowDays: number;
    /** total = input (incl. cache) + output; fresh = total minus cache reads; output = output only. */
    metric: "total" | "fresh" | "output";
    /**
     * t3-usage: the same numbers as T3 Code's Usage page (every local Claude Code, Codex, Grok,
     * Pi and OpenCode session). t3-turns: only turns that ran inside T3 Code.
     */
    source: "t3-usage" | "t3-turns";
  };
  showModel: boolean;
  /** Show the project folder name (never chat names). Off by default. */
  showProject: boolean;
  showElapsed: boolean;
  /** Show the sleeping mascot while T3 Code is open but nothing is running. */
  showIdle: boolean;
  /** Seconds between rotating the second line (agents ⇄ tokens). 0 disables rotation. */
  rotateSec: number;
  /** How long the celebration / snag art stays after a run ends. */
  doneHoldSec: number;
  errorHoldSec: number;
  /** Clear the presence when T3 Code closes. */
  clearWhenClosed: boolean;
  pollMs: number;
  buttons: Button[];
  art: {
    /** Public base URL of the assets/art folder. */
    baseUrl: string;
    /** Cache-buster appended as ?v= (bump when art changes). */
    version: string;
    /** Render exact orchestration rings on demand and publish them to a GitHub repo you own. */
    dynamic: {
      enabled: boolean;
      /** owner/name of a public repo. */
      githubRepo: string;
      branch: string;
      /** Max mascots drawn in a ring (the badge still shows the exact count). */
      maxOrbiters: number;
    };
  };
  /** T3 Code home (defaults to ~/.t3 / $T3CODE_HOME). */
  t3Home: string | null;
}

export const DEFAULT_CONFIG: Config = {
  clientId: DEFAULT_CLIENT_ID,
  appName: "T3 Code",
  activityType: 0,
  statusDisplay: "name",
  tokens: { show: true, windowDays: 30, metric: "total", source: "t3-usage" },
  showModel: true,
  showProject: false,
  showElapsed: true,
  showIdle: true,
  rotateSec: 20,
  doneHoldSec: 90,
  errorHoldSec: 60,
  clearWhenClosed: true,
  pollMs: 1000,
  buttons: [
    { label: "Get T3 Code", url: "https://t3.codes" },
    { label: "T3Code RPC", url: REPO_URL },
  ],
  art: {
    baseUrl: `https://raw.githubusercontent.com/${REPO}/main/assets/art`,
    version: "1",
    dynamic: { enabled: false, githubRepo: REPO, branch: "art-cache", maxOrbiters: 16 },
  },
  t3Home: null,
};

export function rpcHome(): string {
  return process.env.T3CODE_RPC_HOME || join(homedir(), ".t3code-rpc");
}

export const configPath = (): string => join(rpcHome(), "config.json");

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge user values over defaults, keeping only keys/types the defaults know. */
function merge<T>(defaults: T, user: unknown): T {
  if (!isObject(defaults) || !isObject(user)) {
    if (user === undefined) return defaults;
    if (defaults === null) return user as T;
    if (Array.isArray(defaults)) return (Array.isArray(user) ? user : defaults) as T;
    return (typeof user === typeof defaults ? user : defaults) as T;
  }
  const out: Json = { ...defaults };
  for (const key of Object.keys(defaults)) out[key] = merge((defaults as Json)[key], user[key]);
  return out as T;
}

export function loadConfig(): Config {
  let user: unknown = {};
  const file = configPath();
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
    }
  }
  const cfg = merge(DEFAULT_CONFIG, user);
  if (process.env.T3CODE_RPC_CLIENT_ID) cfg.clientId = process.env.T3CODE_RPC_CLIENT_ID;
  cfg.tokens.windowDays = Math.max(0, Math.floor(cfg.tokens.windowDays));
  cfg.pollMs = Math.max(250, cfg.pollMs);
  cfg.rotateSec = Math.max(0, cfg.rotateSec);
  return cfg;
}

/** Read the raw user config (not merged), for `config set`. */
export function readUserConfig(): Json {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return isObject(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function writeUserConfig(json: Json): void {
  mkdirSync(rpcHome(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(json, null, 2) + "\n");
}

/** Set a dotted key (e.g. "tokens.windowDays") from a CLI string value. */
export function setConfigValue(dotted: string, raw: string): Json {
  const json = readUserConfig();
  const keys = dotted.split(".");
  // validate the key against the defaults
  let probe: unknown = DEFAULT_CONFIG;
  for (const k of keys) {
    if (!isObject(probe) || !(k in probe)) throw new Error(`Unknown config key: ${dotted}`);
    probe = probe[k];
  }
  let value: unknown = raw;
  if (typeof probe === "number") value = Number(raw);
  else if (typeof probe === "boolean") value = raw === "true" || raw === "1" || raw === "on" || raw === "yes";
  else if (Array.isArray(probe) || isObject(probe)) value = JSON.parse(raw);
  if (typeof probe === "number" && Number.isNaN(value)) throw new Error(`${dotted} expects a number`);
  let node: Json = json;
  for (const k of keys.slice(0, -1)) {
    if (!isObject(node[k])) node[k] = {};
    node = node[k] as Json;
  }
  node[keys[keys.length - 1]!] = value;
  writeUserConfig(json);
  return json;
}
