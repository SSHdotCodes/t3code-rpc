// Tiny helpers for building SVG strings. Everything is plain strings so the
// renderer has no dependencies beyond a rasterizer.

export const TAU = Math.PI * 2;

/** Round to 2 decimals so SVG output stays compact and deterministic. */
export const n = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

export interface Transform {
  x?: number;
  y?: number;
  rot?: number;
  sx?: number;
  sy?: number;
}

export const tf = ({ x = 0, y = 0, rot = 0, sx = 1, sy = sx }: Transform): string => {
  const parts: string[] = [];
  if (x !== 0 || y !== 0) parts.push(`translate(${n(x)} ${n(y)})`);
  if (rot !== 0) parts.push(`rotate(${n(rot)})`);
  if (sx !== 1 || sy !== 1) parts.push(`scale(${n(sx)} ${n(sy)})`);
  return parts.join(" ");
};

export const g = (t: Transform, body: string, extra = ""): string => {
  const transform = tf(t);
  return `<g${transform ? ` transform="${transform}"` : ""}${extra ? ` ${extra}` : ""}>${body}</g>`;
};

export const rect = (
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  r = 0,
  extra = "",
): string =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${r ? ` rx="${n(r)}"` : ""} fill="${fill}"${extra ? ` ${extra}` : ""}/>`;

export const circle = (cx: number, cy: number, r: number, fill: string, extra = ""): string =>
  `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;

export const ellipse = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fill: string,
  extra = "",
): string =>
  `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;

export const path = (d: string, fill: string, extra = ""): string =>
  `<path d="${d}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;

export const stroke = (d: string, color: string, width: number, extra = ""): string =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"${extra ? ` ${extra}` : ""}/>`;

export const line = (x1: number, y1: number, x2: number, y2: number, color: string, width: number, extra = ""): string =>
  stroke(`M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`, color, width, extra);

/** A 4-point sparkle centered at (0,0) with outer radius r. */
export const sparklePath = (r: number, pinch = 0.28): string => {
  const p = r * pinch;
  return `M0 ${n(-r)}Q${n(p)} ${n(-p)} ${n(r)} 0Q${n(p)} ${n(p)} 0 ${n(r)}Q${n(-p)} ${n(p)} ${n(-r)} 0Q${n(-p)} ${n(-p)} 0 ${n(-r)}Z`;
};

/** Regular polygon / star points helper. */
export const starPath = (points: number, outer: number, inner: number, rot = -90): string => {
  let d = "";
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((rot + (i * 180) / points) * Math.PI) / 180;
    d += `${i === 0 ? "M" : "L"}${n(Math.cos(a) * r)} ${n(Math.sin(a) * r)}`;
  }
  return `${d}Z`;
};

/** Rounded-corner star, nicer for "magic" stars. */
export const softStarPath = (outer: number, inner: number): string => {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((-90 + i * 36) * Math.PI) / 180;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  // Quadratic smoothing through midpoints
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    if (i === 0) {
      const [xl, yl] = pts[pts.length - 1]!;
      d += `M${n((xl + x0) / 2)} ${n((yl + y0) / 2)}`;
    }
    d += `Q${n(x0)} ${n(y0)} ${n(mx)} ${n(my)}`;
  }
  return `${d}Z`;
};

export const svgDoc = (size: number, body: string, defs = ""): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;

// ---- easing / periodic helpers (t is loop phase in [0, 1)) ----

export const wave = (t: number, freq = 1, phase = 0): number => Math.sin(TAU * (t * freq + phase));
export const wave01 = (t: number, freq = 1, phase = 0): number => 0.5 - 0.5 * Math.cos(TAU * (t * freq + phase));
export const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
export const easeInOut = (k: number): number => 0.5 - 0.5 * Math.cos(Math.PI * clamp(k));
export const easeOutBack = (k: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp(k) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
};
/** 0→1→0 pulse inside [start, start+len) of the loop, smooth edges. */
export const pulse = (t: number, start: number, len: number): number => {
  const k = (((t - start) % 1) + 1) % 1;
  if (k >= len) return 0;
  return Math.sin((Math.PI * k) / len);
};
/** Blink curve: eyes closed briefly around `at`. Returns 0 (open) .. 1 (closed). */
export const blinkAt = (t: number, at: number, width = 0.06): number => {
  const d = Math.abs((((t - at) % 1) + 1.5) % 1 - 0.5);
  return d < width ? Math.cos((d / width) * (Math.PI / 2)) : 0;
};
