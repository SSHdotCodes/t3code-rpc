// Config lives in ~/.t3code-rpc/config.json (override the folder with
// T3CODE_RPC_HOME). Everything is optional; missing keys use the defaults.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const DEFAULT_CLIENT_ID = "1561158891293646988";
export const REPO = "SSHdotCodes/t3code-rpc";
export const REPO_URL = `https://github.com/${REPO}`;
export const DEFAULT_CONFIG = {
    clientId: DEFAULT_CLIENT_ID,
    appName: "T3 Code",
    activityType: 0,
    statusDisplay: "name",
    tokens: { show: true, windowDays: 30, metric: "total", source: "t3-usage", showToday: false },
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
        baseUrl: `https://raw.githubusercontent.com/${REPO}/art`,
        version: "2",
        dynamic: { enabled: false, githubRepo: REPO, branch: "art-cache", maxOrbiters: 16 },
    },
    t3Home: null,
};
const ENUM_OPTIONS = {
    activityType: [0, 2, 3, 5],
    statusDisplay: ["name", "details", "state"],
    "tokens.metric": ["total", "fresh", "output"],
    "tokens.source": ["t3-usage", "t3-turns"],
};
function isAllowed(path, value) {
    const allowed = ENUM_OPTIONS[path];
    return !allowed || allowed.includes(value);
}
export function rpcHome() {
    return process.env.T3CODE_RPC_HOME || join(homedir(), ".t3code-rpc");
}
export const configPath = () => join(rpcHome(), "config.json");
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Deep-merge user values over defaults, keeping only keys/types/enums the defaults know. */
function merge(defaults, user, path = "") {
    if (!isObject(defaults) || !isObject(user)) {
        if (user === undefined)
            return defaults;
        if (defaults === null)
            return (user === null || typeof user === "string" ? user : defaults);
        if (Array.isArray(defaults))
            return (Array.isArray(user) ? user : defaults);
        if (typeof user !== typeof defaults)
            return defaults;
        if (typeof user === "number" && !Number.isFinite(user))
            return defaults;
        return (isAllowed(path, user) ? user : defaults);
    }
    const out = { ...defaults };
    for (const key of Object.keys(defaults)) {
        const childPath = path ? `${path}.${key}` : key;
        out[key] = merge(defaults[key], user[key], childPath);
    }
    return out;
}
export function loadConfig() {
    let user = {};
    const file = configPath();
    if (existsSync(file)) {
        try {
            user = JSON.parse(readFileSync(file, "utf8"));
        }
        catch (err) {
            throw new Error(`Could not parse ${file}: ${err.message}`);
        }
    }
    const cfg = merge(DEFAULT_CONFIG, user);
    if (process.env.T3CODE_RPC_CLIENT_ID)
        cfg.clientId = process.env.T3CODE_RPC_CLIENT_ID;
    cfg.tokens.windowDays = Math.max(0, Math.floor(cfg.tokens.windowDays));
    cfg.pollMs = Math.max(250, Math.floor(cfg.pollMs));
    cfg.rotateSec = Math.max(0, cfg.rotateSec);
    cfg.doneHoldSec = Math.max(0, cfg.doneHoldSec);
    cfg.errorHoldSec = Math.max(0, cfg.errorHoldSec);
    cfg.art.dynamic.maxOrbiters = Math.max(1, Math.min(24, Math.floor(cfg.art.dynamic.maxOrbiters)));
    if (cfg.t3Home !== null && cfg.t3Home.trim() === "")
        cfg.t3Home = null;
    return cfg;
}
/** Read the raw user config (not merged), for `config set`. */
export function readUserConfig() {
    try {
        const raw = JSON.parse(readFileSync(configPath(), "utf8"));
        return isObject(raw) ? raw : {};
    }
    catch {
        return {};
    }
}
export function writeUserConfig(json) {
    mkdirSync(rpcHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(json, null, 2) + "\n");
}
function resolveDefaultKey(dotted) {
    const keys = dotted.split(".").filter(Boolean);
    if (keys.length === 0)
        throw new Error(`Unknown config key: ${dotted}`);
    let probe = DEFAULT_CONFIG;
    for (const k of keys) {
        if (!isObject(probe) || !Object.hasOwn(probe, k))
            throw new Error(`Unknown config key: ${dotted}`);
        probe = probe[k];
    }
    return { keys, probe };
}
function parseBool(dotted, raw) {
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "on" || lower === "yes")
        return true;
    if (lower === "false" || lower === "0" || lower === "off" || lower === "no")
        return false;
    throw new Error(`${dotted} expects a boolean (true/false)`);
}
/** Set a dotted key (e.g. "tokens.windowDays") from a CLI string value. */
export function setConfigValue(dotted, raw) {
    const json = readUserConfig();
    const { keys, probe } = resolveDefaultKey(dotted);
    let value = raw;
    if (probe === null) {
        const trimmed = raw.trim();
        value = trimmed === "" || trimmed.toLowerCase() === "null" ? null : trimmed;
    }
    else if (typeof probe === "number") {
        value = Number(raw);
        if (!Number.isFinite(value))
            throw new Error(`${dotted} expects a number`);
    }
    else if (typeof probe === "boolean") {
        value = parseBool(dotted, raw);
    }
    else if (Array.isArray(probe) || isObject(probe)) {
        value = JSON.parse(raw);
        if (Array.isArray(probe) && !Array.isArray(value))
            throw new Error(`${dotted} expects a JSON array`);
        if (isObject(probe) && !isObject(value))
            throw new Error(`${dotted} expects a JSON object`);
    }
    if (!isAllowed(dotted, value)) {
        throw new Error(`${dotted} must be one of: ${ENUM_OPTIONS[dotted].join(", ")}`);
    }
    if (dotted === "pollMs" && value < 250)
        throw new Error("pollMs must be at least 250");
    if ((dotted === "tokens.windowDays" || dotted === "rotateSec" || dotted === "doneHoldSec" || dotted === "errorHoldSec") && value < 0) {
        throw new Error(`${dotted} cannot be negative`);
    }
    if (dotted === "art.dynamic.maxOrbiters" && (value < 1 || value > 24)) {
        throw new Error("art.dynamic.maxOrbiters must be between 1 and 24");
    }
    let node = json;
    for (const k of keys.slice(0, -1)) {
        if (!isObject(node[k]))
            node[k] = {};
        node = node[k];
    }
    node[keys[keys.length - 1]] = value;
    writeUserConfig(json);
    return json;
}
/** Remove a dotted key from the user config so it reverts to its default. */
export function unsetConfigValue(dotted) {
    const { keys } = resolveDefaultKey(dotted);
    const json = readUserConfig();
    const stack = [];
    let node = json;
    for (const k of keys.slice(0, -1)) {
        if (!isObject(node[k]))
            return json;
        stack.push({ node, key: k });
        node = node[k];
    }
    delete node[keys[keys.length - 1]];
    for (let i = stack.length - 1; i >= 0; i--) {
        const { node: parent, key } = stack[i];
        if (isObject(parent[key]) && Object.keys(parent[key]).length === 0)
            delete parent[key];
    }
    writeUserConfig(json);
    return json;
}
/** Reset user config back to defaults. */
export function resetConfig() {
    writeUserConfig({});
    return {};
}
