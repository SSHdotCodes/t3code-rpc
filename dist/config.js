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
    tokens: { show: true, windowDays: 30, metric: "total" },
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
export function rpcHome() {
    return process.env.T3CODE_RPC_HOME || join(homedir(), ".t3code-rpc");
}
export const configPath = () => join(rpcHome(), "config.json");
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Deep-merge user values over defaults, keeping only keys/types the defaults know. */
function merge(defaults, user) {
    if (!isObject(defaults) || !isObject(user)) {
        if (user === undefined)
            return defaults;
        if (defaults === null)
            return user;
        if (Array.isArray(defaults))
            return (Array.isArray(user) ? user : defaults);
        return (typeof user === typeof defaults ? user : defaults);
    }
    const out = { ...defaults };
    for (const key of Object.keys(defaults))
        out[key] = merge(defaults[key], user[key]);
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
    cfg.pollMs = Math.max(250, cfg.pollMs);
    cfg.rotateSec = Math.max(0, cfg.rotateSec);
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
/** Set a dotted key (e.g. "tokens.windowDays") from a CLI string value. */
export function setConfigValue(dotted, raw) {
    const json = readUserConfig();
    const keys = dotted.split(".");
    // validate the key against the defaults
    let probe = DEFAULT_CONFIG;
    for (const k of keys) {
        if (!isObject(probe) || !(k in probe))
            throw new Error(`Unknown config key: ${dotted}`);
        probe = probe[k];
    }
    let value = raw;
    if (typeof probe === "number")
        value = Number(raw);
    else if (typeof probe === "boolean")
        value = raw === "true" || raw === "1" || raw === "on" || raw === "yes";
    else if (Array.isArray(probe) || isObject(probe))
        value = JSON.parse(raw);
    if (typeof probe === "number" && Number.isNaN(value))
        throw new Error(`${dotted} expects a number`);
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
