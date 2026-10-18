// Characters are the real logos come to life: each provider's actual mark
// (assets/src/logos) with little stick arms and legs, in the spirit of
// codex-rpc. Claude is represented by Clawd, the Claude Code mascot.
//
// Every character is drawn around its own origin (0,0) = center of the feet
// line, roughly 100px tall at scale 1. Poses are plain numbers so scenes can
// animate them smoothly frame by frame.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { circle, ellipse, g, line, n, path, rect, stroke } from "./svg.js";
export const CHARACTER_KINDS = [
    "t3",
    "claude",
    "codex",
    "grok",
    "gemini",
    "cursor",
    "opencode",
    "muse",
    "mistral",
    "pi",
    "antigravity",
    "generic",
];
// ---------------------------------------------------------------------------
// Logo bodies
// ---------------------------------------------------------------------------
const LOGO_DIR = fileURLToPath(new URL("../../assets/src/logos/", import.meta.url));
const LOGOS = {
    t3: { file: "t3-nightly.svg", size: 92, limb: "#c9bcff" },
    codex: { file: "codex.svg", viewBox: "62 62 388 388", size: 98, limb: "#8584f1" },
    grok: { file: "grok.svg", size: 88, limb: "#e6e8f0" },
    gemini: { file: "gemini.svg", size: 98, limb: "#8f8cf4" },
    cursor: { file: "cursor.svg", size: 88, limb: "#d0d0da" },
    opencode: { file: "opencode.svg", size: 88, limb: "#d6d2c4" },
    muse: { file: "muse.svg", size: 88, limb: "#4ea4ff" },
    mistral: { file: "mistral.svg", size: 88, limb: "#ff8205" },
    pi: { file: "pi.svg", size: 88, limb: "#e6e6e6" },
    antigravity: { file: "antigravity.svg", size: 88, limb: "#7fb0ff" },
};
const logoCache = new Map();
export function loadLogo(file) {
    let hit = logoCache.get(file);
    if (!hit) {
        const raw = readFileSync(LOGO_DIR + file, "utf8").replace(/<\?xml[^>]*>/, "").replace(/<!--.*?-->/gs, "");
        const open = raw.match(/<svg\b[^>]*>/)[0];
        const viewBox = open.match(/viewBox=['"]([^'"]+)['"]/)[1];
        hit = { viewBox, inner: raw.slice(raw.indexOf(open) + open.length, raw.lastIndexOf("</svg>")) };
        logoCache.set(file, hit);
    }
    return hit;
}
/** The bare logo centered at (0,0), `size` px wide. Used for bodies and orbiters. */
export function logo(kind, size) {
    if (kind === "claude")
        return g({ sx: size / 112 }, clawdBody({}, true));
    if (kind === "generic")
        return genericBody(size);
    const spec = LOGOS[kind];
    const { viewBox, inner } = loadLogo(spec.file);
    return `<svg x="${n(-size / 2)}" y="${n(-size / 2)}" width="${n(size)}" height="${n(size)}" viewBox="${spec.viewBox ?? viewBox}" preserveAspectRatio="xMidYMid meet" overflow="visible">${inner}</svg>`;
}
function genericBody(size) {
    return g({ sx: size / 88 }, rect(-44, -44, 88, 88, "#2a2f45", 20) +
        rect(-30, -24, 60, 40, "#7fd3c4", 12) +
        circle(-12, -4, 5.5, "#1a1433") +
        circle(12, -4, 5.5, "#1a1433"));
}
// ---------------------------------------------------------------------------
// Limbs
// ---------------------------------------------------------------------------
const LEG = 15;
function rigFor(kind) {
    if (kind === "claude") {
        return { size: 96, cy: -38, limb: "#d97757", sx: 46, sy: -50, armLen: 15, armThick: 12, rest: 90 };
    }
    const size = kind === "generic" ? 88 : LOGOS[kind].size;
    const limb = kind === "generic" ? "#7fd3c4" : LOGOS[kind].limb;
    const cy = -LEG - size / 2;
    return { size, cy, limb, sx: size / 2 - 3, sy: cy + size * 0.08, armLen: 22, armThick: 6, rest: 22 };
}
/** Rotation (SVG degrees) that points an arm of `side` at `fromDown` degrees away from straight down, outward. */
const armRotation = (side, fromDown) => -side * fromDown;
function armGeometry(rig, side, angle) {
    const rot = armRotation(side, angle ?? rig.rest);
    const rad = (rot * Math.PI) / 180;
    return { rot, hx: side * rig.sx - rig.armLen * Math.sin(rad), hy: rig.sy + rig.armLen * Math.cos(rad) };
}
function drawArm(kind, rig, side, angle) {
    const { rot } = armGeometry(rig, side, angle);
    const limb = kind === "claude"
        ? rect(-rig.armThick / 2, -2, rig.armThick, rig.armLen + 4, rig.limb, 3)
        : line(0, 0, 0, rig.armLen, rig.limb, rig.armThick) + circle(0, rig.armLen, 4.6, rig.limb);
    return g({ x: side * rig.sx, y: rig.sy, rot }, limb);
}
function drawHeld(rig, side, angle, held) {
    if (!held)
        return "";
    const { hx, hy } = armGeometry(rig, side, angle);
    return g({ x: hx, y: hy }, held + circle(0, 0, rig.armThick * 0.75 + 1.5, rig.limb));
}
function legs(rig) {
    const spread = rig.size * 0.2;
    return (line(-spread, -LEG - 2, -spread - 2, -4, rig.limb, 6) +
        line(spread, -LEG - 2, spread + 2, -4, rig.limb, 6) +
        ellipse(-spread - 5, -3.5, 8.5, 4.5, rig.limb) +
        ellipse(spread + 5, -3.5, 8.5, 4.5, rig.limb));
}
function hat(kind, size, phase) {
    // perched on the top-right corner of the body box
    const x = size * 0.26;
    const y = -size / 2 + 2;
    if (kind === "nightcap") {
        const flop = Math.sin(phase * Math.PI * 2) * 4;
        return g({ x, y, rot: 18 }, path(`M-20 2Q-6 -34 ${n(22 + flop)} -24Q8 -18 20 2Z`, "#5b7cff") + rect(-22, -2, 44, 9, "#e9e3ff", 4.5) + circle(22 + flop, -24, 6, "#ffffff"));
    }
    return g({ x, y: y - 2, rot: 14 }, path("M-16 4L0 -34L16 4Z", "#ff8fb1") +
        path("M-9 -12L6 -17M-12 -3L11 -8", "none", `stroke="#ffd66b" stroke-width="3.5" stroke-linecap="round"`) +
        circle(0, -36, 5, "#ffd66b"));
}
// ---------------------------------------------------------------------------
// Clawd
// ---------------------------------------------------------------------------
const INK = "#1a1433";
function clawdBody(pose, bare = false) {
    const u = 8;
    const orange = "#d97757";
    const dark = "#b85e40";
    const w = 12 * u;
    const h = 6.5 * u;
    // bare = centered on (0,0) for use as a logo/orbiter; otherwise standing on y=0
    const bodyTop = bare ? -h / 2 - 1.1 * u : -h - 2.2 * u;
    const legY = bodyTop + h;
    const legsSvg = [-5, -2.8, 1.4, 3.6].map((x) => rect(x * u, legY - 0.4 * u, 1.4 * u, 2.6 * u, dark, 2)).join("");
    const body = rect(-w / 2, bodyTop, w, h, orange, 4) + rect(-w / 2, bodyTop + h - 0.9 * u, w, 0.9 * u, dark, 0, `opacity="0.35"`);
    const nubs = bare
        ? rect(-w / 2 - 1.4 * u, bodyTop + 1.9 * u, 1.6 * u, 1.5 * u, orange, 2) + rect(w / 2 - 0.2 * u, bodyTop + 1.9 * u, 1.6 * u, 1.5 * u, orange, 2)
        : "";
    const ey = bodyTop + 2.4 * u;
    const blink = pose.blink ?? 0;
    const mode = pose.eyes ?? "open";
    let face = "";
    const lx = (pose.lookX ?? 0) * 0.5 * u;
    const ly = (pose.lookY ?? 0) * 0.4 * u;
    for (const side of [-1, 1]) {
        const x = side * 2.6 * u + lx;
        if (mode === "sleep") {
            face += stroke(`M${n(x - 0.9 * u)} ${n(ey + ly)}Q${n(x)} ${n(ey + ly + 0.8 * u)} ${n(x + 0.9 * u)} ${n(ey + ly)}`, INK, 0.45 * u);
        }
        else if (mode === "happy") {
            face += stroke(`M${n(x - 0.9 * u)} ${n(ey + ly + 0.4 * u)}L${n(x)} ${n(ey + ly - 0.5 * u)}L${n(x + 0.9 * u)} ${n(ey + ly + 0.4 * u)}`, INK, 0.45 * u);
        }
        else {
            const eh = 1.9 * u * (1 - blink * 0.85) * (mode === "focus" ? 0.65 : 1);
            face += rect(x - 0.5 * u, ey + ly - eh / 2, 1 * u, eh, INK, 1.5);
        }
    }
    return legsSvg + nubs + body + face;
}
/** Height of each character's top above its feet, for placing props. */
export const HEAD_TOP = Object.fromEntries(CHARACTER_KINDS.map((k) => [k, k === "claude" ? 70 : -rigFor(k).cy + rigFor(k).size / 2]));
/** Brand color for each character, used for orbit trails and accents. */
export const BRAND = {
    t3: "#8f7cff",
    claude: "#d97757",
    codex: "#8584f1",
    grok: "#e6e8f0",
    gemini: "#5f8dff",
    cursor: "#d0d0da",
    opencode: "#d6d2c4",
    muse: "#0081fb",
    mistral: "#ff8205",
    pi: "#e6e6e6",
    antigravity: "#3186ff",
    generic: "#7fd3c4",
};
/** World position of a hand (for attaching effects like wand sparkles). */
export function handPosition(kind, at, side, angle, squash = 1) {
    const s = at.scale ?? 1;
    const { hx, hy } = armGeometry(rigFor(kind), side, angle);
    return { x: at.x + hx * (s / Math.sqrt(squash)), y: at.y + hy * s * squash };
}
export function character(kind, at, pose = {}) {
    const squash = pose.squash ?? 1;
    const s = at.scale ?? 1;
    const rig = rigFor(kind);
    let inner;
    if (kind === "claude") {
        inner = drawArm(kind, rig, -1, pose.armL) + drawArm(kind, rig, 1, pose.armR) + clawdBody(pose);
        if (pose.hat)
            inner += g({ x: 0, y: -46 }, hat(pose.hat, 96, pose.phase ?? 0));
    }
    else {
        const body = g({ x: 0, y: rig.cy, rot: pose.lean ?? 0 }, logo(kind, rig.size) + (pose.hat ? hat(pose.hat, rig.size, pose.phase ?? 0) : ""));
        inner = legs(rig) + drawArm(kind, rig, -1, pose.armL) + drawArm(kind, rig, 1, pose.armR) + body;
    }
    inner += drawHeld(rig, -1, pose.armL, pose.holdL) + drawHeld(rig, 1, pose.armR, pose.holdR);
    return g({ x: at.x, y: at.y, rot: at.rot ?? 0, sx: s / Math.sqrt(squash), sy: s * squash }, inner);
}
