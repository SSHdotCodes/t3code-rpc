// Animated scenes. A scene turns a loop phase t ∈ [0, 1) into one SVG frame.
// Every motion is periodic in t, so the encoded GIFs loop without a seam.
import { BRAND, character, HEAD_TOP, handPosition, logo } from "./characters.js";
import { background, codeWindow, confetti, countBadge, globe, magnifier, page, PALETTE, pixelText, rainCloud, shadow, sign, sparkle, sweatDrop, terminalWindow, thoughtBubble, wand, zzz, } from "./props.js";
import { blinkAt, circle, ellipse, g, n, pulse, svgDoc, TAU, wave, wave01 } from "./svg.js";
export const ACTIVITY_SCENES = ["idle", "thinking", "coding", "terminal", "reading", "web", "waiting", "done", "error"];
export function timingFor(spec) {
    switch (spec.scene) {
        case "idle":
            return { seconds: 4, fps: 20 };
        case "orbit":
            return { seconds: 4.8, fps: 20 };
        case "thinking":
        case "web":
            return { seconds: 3, fps: 25 };
        case "done":
            return { seconds: 2, fps: 25 };
        default:
            return { seconds: 2.4, fps: 25 };
    }
}
const FEET = 214;
// ---------------------------------------------------------------------------
function idle(kind, t) {
    const s = 1.05;
    return (background(t, { moon: true }) +
        shadow(128, FEET + 2, 46, 1 + 0.04 * wave(t, 1)) +
        character(kind, { x: 128, y: FEET, scale: s }, { eyes: "sleep", squash: 1 + 0.035 * wave(t, 1), lean: -6 + 3 * wave(t, 1), armL: 14, armR: 14, hat: "nightcap", phase: t }) +
        zzz(t, 128 + 40, FEET - HEAD_TOP[kind] * s - 6));
}
function thinking(kind, t) {
    const bob = wave(t, 2) * 2.2;
    const s = 0.95;
    let out = background(t);
    out += shadow(100, FEET + 2, 42);
    out += character(kind, { x: 100, y: FEET + bob * 0.3, scale: s }, { lookX: 0.6, lookY: -0.75, blink: blinkAt(t, 0.62), lean: 5 + 3 * wave(t, 1), armL: 30, armR: 128 + 10 * wave01(t, 2), phase: t });
    out += thoughtBubble(t, 182, 58);
    out += sparkle(222, 100, 5 * pulse(t, 0.1, 0.5), PALETTE.goldLight);
    out += sparkle(140, 34, 4 * pulse(t, 0.55, 0.5), PALETTE.starSoft);
    return out;
}
function coding(kind, t) {
    const s = 0.88;
    const x = 80;
    const hop = Math.abs(wave(t, 4)) * 1.6;
    let out = background(t);
    out += codeWindow(t, 136, 40, 108, 92);
    out += shadow(x, FEET + 2, 44);
    out += character(kind, { x, y: FEET - 10 - hop, scale: s }, { eyes: "focus", lookX: 0.8, blink: blinkAt(t, 0.45), lean: 3, armL: 28 + 16 * wave01(t, 6), armR: 28 + 16 * wave01(t, 6, 0.5), phase: t });
    // keyboard in front, the hands tap on it
    const kx = x - 48;
    const ky = FEET - 12;
    out += rect3d(kx, ky, 96, 18);
    for (let i = 0; i < 7; i++) {
        const pressed = pulse(t * 6, i / 7, 0.25);
        out += `<rect x="${n(kx + 6 + i * 12.6)}" y="${n(ky + 4 + pressed * 1.5)}" width="9.5" height="${n(7 - pressed * 1.5)}" rx="2" fill="${pressed > 0.3 ? PALETTE.mint : "#c9bcff"}"/>`;
    }
    for (let i = 0; i < 3; i++) {
        const k = (t * 2 + i / 3) % 1;
        out += sparkle(kx + 84 + k * 50, ky - 10 - k * 70 - Math.sin(k * Math.PI) * 14, 3.5 * Math.sin(k * Math.PI), PALETTE.goldLight);
    }
    return out;
}
function rect3d(x, y, w, h) {
    return (`<rect x="${n(x)}" y="${n(y + 4)}" width="${n(w)}" height="${n(h)}" rx="6" fill="#1b1545"/>` +
        `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="6" fill="#2e2470" stroke="#8f7cff" stroke-width="2"/>`);
}
function terminal(kind, t) {
    const s = 0.86;
    const x = 66;
    const hop = Math.max(0, wave(t, 2)) * 5;
    let out = background(t);
    out += terminalWindow(t, 122, 44, 118, 96);
    out += shadow(x, FEET + 2, 38, 1 - hop * 0.02);
    out += character(kind, { x, y: FEET - hop, scale: s }, { squash: 1 + 0.04 * wave(t, 2, 0.25), lookX: 0.9, lookY: -0.45, blink: blinkAt(t, 0.8), lean: 4, armL: 30, armR: 112 + 12 * wave(t, 2), phase: t });
    out += sparkle(118, 160 - 20 * ((t * 2) % 1), 4 * Math.sin(((t * 2) % 1) * Math.PI), PALETTE.mint);
    return out;
}
function reading(kind, t) {
    const s = 0.88;
    const x = 176;
    let out = background(t);
    out += page(70, 106 + wave(t, 1) * 4, -6 + 4 * wave(t, 1));
    out += page(96, 122 + wave(t, 1, 0.3) * 4, 8 + 3 * wave(t, 1, 0.5));
    const mx = 84 + 22 * Math.sin(t * TAU);
    const my = 130 + 12 * Math.sin(t * TAU * 2);
    out += g({ x: mx, y: my + 32, rot: -18 }, magnifier(2 * wave(t, 2)));
    out += shadow(x, FEET + 2, 40);
    out += character(kind, { x, y: FEET, scale: s }, { lookX: -0.9 + 0.25 * Math.sin(t * TAU), lookY: -0.2, blink: blinkAt(t, 0.3), lean: -4, armL: 100 + 10 * Math.sin(t * TAU), armR: 26, phase: t });
    out += sparkle(mx + 22, my - 8, 4 * pulse(t * 2, 0.2, 0.5), PALETTE.goldLight);
    return out;
}
function web(kind, t) {
    const s = 0.82;
    const bob = wave(t, 1) * 3;
    let out = background(t);
    const top = FEET - HEAD_TOP[kind] * s;
    out += globe(t, 128, Math.min(top - 42, 88) + bob, 34);
    out += shadow(128, FEET + 2, 40);
    out += character(kind, { x: 128, y: FEET, scale: s }, { lookY: -1, blink: blinkAt(t, 0.5), armL: 158 + 6 * wave(t, 1), armR: 158 + 6 * wave(t, 1, 0.5), phase: t });
    return out;
}
function waiting(kind, t) {
    const s = 0.9;
    const x = 112;
    const k = (t * 2) % 1;
    const hop = Math.sin(k * Math.PI) * 12;
    const squash = k < 0.12 || k > 0.88 ? 0.92 : 1 + 0.05 * Math.sin(k * Math.PI);
    let out = background(t);
    out += shadow(x, FEET + 2, 40, 1 - hop / 40);
    out += character(kind, { x, y: FEET - hop, scale: s }, { squash, blink: blinkAt(t, 0.25), armL: 40 + 10 * wave(t, 2), armR: 165 + 6 * wave(t, 2), holdR: g({ rot: 8 * wave(t, 2) }, sign("?")), phase: t });
    const p = pulse(t * 2, 0.05, 0.5);
    out += g({ x: 44, y: 74 - p * 6 }, pixelText("!", 0, 0, 4.4 * (0.6 + 0.4 * p), PALETTE.gold), `opacity="${n(0.3 + 0.7 * p)}"`);
    return out;
}
function done(kind, t) {
    const s = 0.92;
    const hop = Math.sin(t * Math.PI) * 22;
    const squash = t < 0.1 || t > 0.9 ? 0.9 : 1.04;
    let out = background(t);
    out += confetti(t);
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + t * TAU * 0.5;
        const r = 74 + 6 * wave(t, 2, i / 6);
        out += sparkle(128 + Math.cos(a) * r, 124 + Math.sin(a) * r * 0.7, 5 + 2 * wave(t, 2, i / 6), i % 2 ? PALETTE.goldLight : PALETTE.starSoft);
    }
    out += shadow(128, FEET + 2, 42, 1 - hop / 60);
    out += character(kind, { x: 128, y: FEET - hop, scale: s }, { eyes: "happy", squash, armL: 150 + 15 * wave(t, 2), armR: 150 + 15 * wave(t, 2, 0.5), hat: "party", lean: 6 * wave(t, 1), phase: t });
    return out;
}
function error(kind, t) {
    const s = 0.96;
    let out = background(t);
    const top = FEET - HEAD_TOP[kind] * s;
    out += shadow(128, FEET + 2, 44);
    out += character(kind, { x: 128, y: FEET, scale: s }, { blink: blinkAt(t, 0.7), lookY: 0.6, lean: -10 + 2 * wave(t, 1), armL: 8, armR: 8, squash: 0.97, phase: t });
    out += rainCloud(t, 128, Math.max(40, top - 34));
    out += sweatDrop(128 + 48, top + 22, (t * 2) % 1);
    return out;
}
// ---------------------------------------------------------------------------
// Orchestration: the conductor floats and waves a wand while its subagents —
// real provider logos — circle around it.
// ---------------------------------------------------------------------------
function orbit(kind, t, orbiters, count) {
    const N = Math.max(1, orbiters.length);
    const cx = 128;
    const cy = 172;
    const rx = 104;
    const ry = 32;
    const mini = N <= 2 ? 46 : N <= 4 ? 40 : N <= 6 ? 35 : N <= 8 ? 31 : N <= 10 ? 27 : N <= 12 ? 24 : 21;
    const s = 0.72;
    const liftAt = (tt) => 40 + 4 * wave(tt, 2);
    const at = { x: 128, y: FEET - liftAt(t), scale: s };
    const conduct = (tt) => ({ armR: 150 + 12 * wave(tt, 2), tilt: -10 + 26 * wave(tt, 2, 0.15) });
    const wandLen = 50;
    const tipOf = (tt) => {
        const c = conduct(tt);
        const hand = handPosition(kind, { ...at, y: FEET - liftAt(tt) }, 1, c.armR);
        const a = (c.tilt * Math.PI) / 180;
        const reach = (wandLen + 11) * s;
        return { x: hand.x + Math.sin(a) * reach, y: hand.y - Math.cos(a) * reach };
    };
    const now = conduct(t);
    const items = [];
    orbiters.forEach((o, i) => {
        const th = TAU * (i / N + t);
        const depth = Math.sin(th);
        const d01 = (depth + 1) / 2;
        const size = mini * (0.78 + 0.36 * d01);
        const x = cx + Math.cos(th) * rx;
        const y = cy + depth * ry;
        const hopK = (t * 4 + i / N) % 1;
        const hop = Math.sin(hopK * Math.PI) * 5;
        const fade = 0.62 + 0.38 * d01;
        const color = BRAND[o];
        let trail = "";
        for (let k = 1; k <= 4; k++) {
            const tth = th - k * 0.13;
            trail += circle(cx + Math.cos(tth) * rx, cy + Math.sin(tth) * ry, (3.6 - k * 0.7) * (0.7 + 0.5 * d01), color, `opacity="${n((0.75 - k * 0.15) * fade)}"`);
        }
        const shade = ellipse(x, y + size * 0.5 + 2, size * 0.42, size * 0.1, "#0c0a22", `opacity="${n(0.4 * fade)}"`);
        const body = g({ x, y: y - hop, rot: 8 * Math.sin(hopK * TAU) }, logo(o, size));
        items.push({ depth, svg: `<g opacity="${n(fade)}">${trail}${shade}${body}</g>` });
    });
    let out = background(t);
    out += ellipse(cx, cy, rx, ry, "none", `stroke="${PALETTE.lilac}" stroke-width="2" stroke-dasharray="3 7" opacity="0.4"`);
    out += shadow(128, FEET + 2, 30, 0.8 - 0.05 * wave(t, 2));
    const back = items.filter((it) => it.depth < 0).sort((a, b) => a.depth - b.depth);
    const front = items.filter((it) => it.depth >= 0).sort((a, b) => a.depth - b.depth);
    out += back.map((it) => it.svg).join("");
    for (let i = 0; i < 3; i++) {
        const k = (t * 2 + i / 3) % 1;
        out += sparkle(128 - 20 + i * 20 + 6 * wave(k, 1), at.y + 4 + k * 22, 4 * Math.sin(k * Math.PI), i === 1 ? PALETTE.goldLight : PALETTE.starSoft);
    }
    out += character(kind, at, {
        armR: now.armR,
        holdR: g({ rot: now.tilt }, wand(t, wandLen)),
        armL: 70 + 14 * wave(t, 2, 0.5),
        lookX: 0.5 * Math.cos(t * TAU),
        lookY: 0.35,
        blink: blinkAt(t, 0.15),
        lean: 4 * wave(t, 2, 0.1),
        phase: t,
    });
    for (let k = 1; k <= 6; k++) {
        const p = tipOf(t - k * 0.022);
        out += sparkle(p.x, p.y, Math.max(0, 6.5 - k), k % 2 ? PALETTE.goldLight : "#ffffff", k * 20);
    }
    out += front.map((it) => it.svg).join("");
    out += countBadge(count);
    return out;
}
// ---------------------------------------------------------------------------
export function renderFrame(spec, t, size = 320) {
    const kind = spec.character;
    let body;
    switch (spec.scene) {
        case "idle":
            body = idle(kind, t);
            break;
        case "thinking":
            body = thinking(kind, t);
            break;
        case "coding":
            body = coding(kind, t);
            break;
        case "terminal":
            body = terminal(kind, t);
            break;
        case "reading":
            body = reading(kind, t);
            break;
        case "web":
            body = web(kind, t);
            break;
        case "waiting":
            body = waiting(kind, t);
            break;
        case "done":
            body = done(kind, t);
            break;
        case "error":
            body = error(kind, t);
            break;
        case "orbit": {
            const orbiters = spec.orbiters && spec.orbiters.length > 0 ? spec.orbiters : [spec.character];
            body = orbit(kind, t, orbiters, spec.countLabel ?? spec.count ?? orbiters.length);
            break;
        }
    }
    return svgDoc(size, body);
}
export function frameCount(spec) {
    const { seconds, fps } = timingFor(spec);
    return Math.round(seconds * fps);
}
