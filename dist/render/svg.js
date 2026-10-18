// Tiny helpers for building SVG strings. Everything is plain strings so the
// renderer has no dependencies beyond a rasterizer.
export const TAU = Math.PI * 2;
/** Round to 2 decimals so SVG output stays compact and deterministic. */
export const n = (v) => {
    const r = Math.round(v * 100) / 100;
    return Object.is(r, -0) ? "0" : String(r);
};
export const tf = ({ x = 0, y = 0, rot = 0, sx = 1, sy = sx }) => {
    const parts = [];
    if (x !== 0 || y !== 0)
        parts.push(`translate(${n(x)} ${n(y)})`);
    if (rot !== 0)
        parts.push(`rotate(${n(rot)})`);
    if (sx !== 1 || sy !== 1)
        parts.push(`scale(${n(sx)} ${n(sy)})`);
    return parts.join(" ");
};
export const g = (t, body, extra = "") => {
    const transform = tf(t);
    return `<g${transform ? ` transform="${transform}"` : ""}${extra ? ` ${extra}` : ""}>${body}</g>`;
};
export const rect = (x, y, w, h, fill, r = 0, extra = "") => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${r ? ` rx="${n(r)}"` : ""} fill="${fill}"${extra ? ` ${extra}` : ""}/>`;
export const circle = (cx, cy, r, fill, extra = "") => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;
export const ellipse = (cx, cy, rx, ry, fill, extra = "") => `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;
export const path = (d, fill, extra = "") => `<path d="${d}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;
export const stroke = (d, color, width, extra = "") => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"${extra ? ` ${extra}` : ""}/>`;
export const line = (x1, y1, x2, y2, color, width, extra = "") => stroke(`M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`, color, width, extra);
/** A 4-point sparkle centered at (0,0) with outer radius r. */
export const sparklePath = (r, pinch = 0.28) => {
    const p = r * pinch;
    return `M0 ${n(-r)}Q${n(p)} ${n(-p)} ${n(r)} 0Q${n(p)} ${n(p)} 0 ${n(r)}Q${n(-p)} ${n(p)} ${n(-r)} 0Q${n(-p)} ${n(-p)} 0 ${n(-r)}Z`;
};
/** Regular polygon / star points helper. */
export const starPath = (points, outer, inner, rot = -90) => {
    let d = "";
    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = ((rot + (i * 180) / points) * Math.PI) / 180;
        d += `${i === 0 ? "M" : "L"}${n(Math.cos(a) * r)} ${n(Math.sin(a) * r)}`;
    }
    return `${d}Z`;
};
/** Rounded-corner star, nicer for "magic" stars. */
export const softStarPath = (outer, inner) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = ((-90 + i * 36) * Math.PI) / 180;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    // Quadratic smoothing through midpoints
    let d = "";
    for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[(i + 1) % pts.length];
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        if (i === 0) {
            const [xl, yl] = pts[pts.length - 1];
            d += `M${n((xl + x0) / 2)} ${n((yl + y0) / 2)}`;
        }
        d += `Q${n(x0)} ${n(y0)} ${n(mx)} ${n(my)}`;
    }
    return `${d}Z`;
};
export const svgDoc = (size, body, defs = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
// ---- easing / periodic helpers (t is loop phase in [0, 1)) ----
export const wave = (t, freq = 1, phase = 0) => Math.sin(TAU * (t * freq + phase));
export const wave01 = (t, freq = 1, phase = 0) => 0.5 - 0.5 * Math.cos(TAU * (t * freq + phase));
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const easeInOut = (k) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(k));
export const easeOutBack = (k) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const x = clamp(k) - 1;
    return 1 + c3 * x * x * x + c1 * x * x;
};
/** 0→1→0 pulse inside [start, start+len) of the loop, smooth edges. */
export const pulse = (t, start, len) => {
    const k = (((t - start) % 1) + 1) % 1;
    if (k >= len)
        return 0;
    return Math.sin((Math.PI * k) / len);
};
/** Blink curve: eyes closed briefly around `at`. Returns 0 (open) .. 1 (closed). */
export const blinkAt = (t, at, width = 0.06) => {
    const d = Math.abs((((t - at) % 1) + 1.5) % 1 - 0.5);
    return d < width ? Math.cos((d / width) * (Math.PI / 2)) : 0;
};
