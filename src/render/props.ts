// Scene props and the shared night-sky backdrop. Every prop takes the loop
// phase t in [0, 1) and only uses periodic motion, so GIFs loop seamlessly.

import {
  circle,
  ellipse,
  g,
  line,
  n,
  path,
  pulse,
  rect,
  softStarPath,
  sparklePath,
  stroke,
  TAU,
  wave,
  wave01,
} from "./svg.ts";

export const PALETTE = {
  sky: "#17123a",
  glow1: "#1d1748",
  glow2: "#231c56",
  cloudBack: "#2a2163",
  cloudFront: "#362a80",
  star: "#ffffff",
  starSoft: "#c9b8ff",
  gold: "#ffd66b",
  goldLight: "#fff1b8",
  ink: "#1a1433",
  panel: "#0f0c24",
  panelEdge: "#4a3c9e",
  mint: "#7ef0c1",
  pink: "#ff8fb1",
  sky2: "#7cc4ff",
  lilac: "#b9a6ff",
};

const STARS: Array<[number, number, number, number]> = [
  // x, y, radius, phase
  [28, 30, 4.5, 0.0],
  [214, 24, 3.5, 0.35],
  [62, 70, 2.5, 0.7],
  [236, 84, 3, 0.15],
  [176, 46, 2.2, 0.55],
  [18, 118, 2.4, 0.85],
  [110, 18, 2.2, 0.45],
  [238, 140, 2, 0.25],
];

export function background(t: number, opts: { moon?: boolean } = {}): string {
  let out = rect(0, 0, 256, 256, PALETTE.sky);
  out += circle(128, 132, 124, PALETTE.glow1);
  out += circle(128, 138, 92, PALETTE.glow2);
  for (const [x, y, r, ph] of STARS) {
    const k = wave01(t, 1, ph);
    out += g({ x, y, rot: 45 * k * 0.0, sx: 0.55 + 0.45 * k }, path(sparklePath(r * 1.6), k > 0.5 ? PALETTE.star : PALETTE.starSoft));
  }
  if (opts.moon) {
    out += circle(214, 52, 15, "#fff3c9") + circle(221, 46, 13, PALETTE.sky);
  }
  // back cloud bank
  for (const [x, r] of [[-6, 34], [40, 26], [88, 30], [140, 24], [186, 32], [236, 28], [270, 30]] as const) {
    out += circle(x, 236, r, PALETTE.cloudBack);
  }
  // front cloud bank
  for (const [x, r] of [[10, 26], [56, 30], [110, 24], [158, 30], [208, 26], [252, 30]] as const) {
    out += circle(x, 252, r, PALETTE.cloudFront);
  }
  out += rect(0, 240, 256, 16, PALETTE.cloudFront);
  return out;
}

export function shadow(x: number, y: number, w: number, k = 1): string {
  return ellipse(x, y, w * k, 5 * k, "#0c0a22", `opacity="0.55"`);
}

// ---------------------------------------------------------------------------

export function sparkle(x: number, y: number, r: number, color: string = PALETTE.goldLight, rot = 0): string {
  return g({ x, y, rot }, path(sparklePath(r), color));
}

/** Magic wand pointing up from the hand (origin = grip). */
export function wand(t: number, length = 40): string {
  const glow = 0.65 + 0.35 * wave01(t, 2);
  return (
    line(0, 8, 0, -length, "#3a2a5c", 7) +
    line(0, -length + 8, 0, -length + 1, "#ffffff", 7) +
    line(0, 6, 0, -2, "#ffffff", 7) +
    circle(0, -length - 11, 20 * glow, PALETTE.gold, `opacity="0.25"`) +
    g({ x: 0, y: -length - 11, rot: 72 * t }, path(softStarPath(16, 7.4), PALETTE.gold) + path(softStarPath(8, 3.7), PALETTE.goldLight))
  );
}

/** Floating z's rising from (x, y). */
export function zzz(t: number, x: number, y: number): string {
  let out = "";
  for (let i = 0; i < 3; i++) {
    const k = (t + i / 3) % 1;
    const s = 0.5 + k * 0.8;
    const o = Math.sin(Math.PI * k);
    const zx = x + k * 26 + Math.sin(k * TAU) * 4;
    const zy = y - k * 46;
    out += g(
      { x: zx, y: zy, sx: s },
      stroke("M-6 -6H6L-6 6H6", "#e9e3ff", 3.2),
      `opacity="${n(o)}"`,
    );
  }
  return out;
}

export function thoughtBubble(t: number, x: number, y: number): string {
  const bob = wave(t, 1) * 2;
  let out =
    circle(x - 34, y + 34 + bob * 0.5, 4, "#ffffff", `opacity="0.85"`) +
    circle(x - 24, y + 22 + bob * 0.7, 6.5, "#ffffff", `opacity="0.9"`);
  out += g(
    { x, y: y + bob },
    circle(-18, 2, 18, "#ffffff") +
      circle(2, -6, 22, "#ffffff") +
      circle(22, 2, 18, "#ffffff") +
      rect(-30, 0, 62, 18, "#ffffff", 9),
  );
  for (let i = 0; i < 3; i++) {
    const p = pulse(t * 2, i * 0.18, 0.4);
    out += circle(x - 14 + i * 14, y + 4 + bob - p * 6, 4.4 + p * 1.2, i === 1 ? "#8f7cff" : "#b9a6ff");
  }
  return out;
}

const CODE_COLORS = ["#ff8fb1", "#7cc4ff", "#ffd66b", "#7ef0c1", "#b9a6ff"];

/** A floating editor window whose lines "type in" and scroll. */
export function codeWindow(t: number, x: number, y: number, w = 92, h = 74): string {
  let out = rect(x, y, w, h, PALETTE.panel, 10) + rect(x, y, w, h, "none", 10, `stroke="${PALETTE.panelEdge}" stroke-width="2.5"`);
  out += circle(x + 10, y + 9, 2.6, "#ff6b8b") + circle(x + 18, y + 9, 2.6, "#ffd66b") + circle(x + 26, y + 9, 2.6, "#7ef0c1");
  const rows = 5;
  const lineH = 11;
  // each line types in over 1/rows of the loop, then scrolls up by one row
  const phase = t * rows;
  const typing = phase % 1;
  const scroll = Math.max(0, (typing - 0.8) / 0.2) * lineH;
  const step = Math.floor(phase);
  out += `<clipPath id="cw"><rect x="${n(x + 4)}" y="${n(y + 18)}" width="${n(w - 8)}" height="${n(h - 22)}"/></clipPath><g clip-path="url(#cw)">`;
  for (let r = 0; r < rows + 1; r++) {
    const seed = (step + r) % 7;
    const indent = [0, 8, 16, 8, 0, 8, 16][seed]!;
    const full = [52, 40, 30, 46, 36, 24, 44][seed]!;
    const color = CODE_COLORS[seed % CODE_COLORS.length]!;
    const isTyping = r === rows - 1;
    const wLine = r < rows - 1 ? full : isTyping ? full * Math.min(1, typing / 0.8) : 0;
    const ly = y + 22 + r * lineH - scroll;
    if (wLine > 0.5) {
      out += rect(x + 9 + indent, ly, Math.min(14, wLine), 5, color, 2.5);
      if (wLine > 16) out += rect(x + 9 + indent + 17, ly, wLine - 17, 5, "#d9d0ff", 2.5, `opacity="0.75"`);
    }
    if (isTyping && Math.sin(t * TAU * 6) > -0.3) {
      out += rect(x + 9 + indent + wLine + 2, ly - 1, 3, 7, "#ffffff", 1);
    }
  }
  out += "</g>";
  return out;
}

/** A terminal window with a prompt and scrolling output. */
export function terminalWindow(t: number, x: number, y: number, w = 100, h = 78): string {
  let out = rect(x, y, w, h, "#0b0a18", 10) + rect(x, y, w, h, "none", 10, `stroke="#5b4fbf" stroke-width="2.5"`);
  out += rect(x, y, w, 15, "#1f1a44", 10) + rect(x, y + 8, w, 7, "#1f1a44");
  out += circle(x + 10, y + 8, 2.6, "#ff6b8b") + circle(x + 18, y + 8, 2.6, "#ffd66b") + circle(x + 26, y + 8, 2.6, "#7ef0c1");
  const rows = 4;
  const lineH = 12;
  const phase = t * rows;
  const k = phase % 1;
  const step = Math.floor(phase);
  const scroll = Math.max(0, (k - 0.75) / 0.25) * lineH;
  out += `<clipPath id="tw"><rect x="${n(x + 4)}" y="${n(y + 18)}" width="${n(w - 8)}" height="${n(h - 22)}"/></clipPath><g clip-path="url(#tw)">`;
  for (let r = 0; r < rows + 1; r++) {
    const seed = (step + r) % 5;
    const ly = y + 22 + r * lineH - scroll;
    const isPrompt = seed % 2 === 0;
    if (isPrompt) {
      out += stroke(`M${n(x + 9)} ${n(ly)}L${n(x + 13)} ${n(ly + 3)}L${n(x + 9)} ${n(ly + 6)}`, PALETTE.mint, 2.2);
      const wCmd = r === rows - 1 ? 50 * Math.min(1, k / 0.6) : [44, 30, 52][seed % 3]!;
      if (wCmd > 0.5) out += rect(x + 18, ly, wCmd, 5, "#e9e3ff", 2.5);
      if (r === rows - 1 && Math.sin(t * TAU * 8) > 0) out += rect(x + 20 + wCmd, ly - 1, 6, 7, PALETTE.mint, 1);
    } else {
      const wOut = r === rows - 1 ? 60 * Math.min(1, k / 0.5) : [62, 48, 70][seed % 3]!;
      if (wOut > 0.5) out += rect(x + 9, ly, wOut, 5, "#7c70c9", 2.5, `opacity="0.85"`);
    }
  }
  out += "</g>";
  return out;
}

export function page(x: number, y: number, rot = 0): string {
  let inner = rect(-22, -28, 44, 56, "#f4f2ff", 6) + path("M10 -28H22V-16Z", "#d9d4ff");
  for (let i = 0; i < 5; i++) inner += rect(-15, -16 + i * 9, i === 4 ? 18 : 30, 4, "#b9b0e8", 2);
  return g({ x, y, rot }, inner);
}

/** Magnifying glass, origin at the handle grip, lens up. */
export function magnifier(glint: number): string {
  return (
    line(0, 6, 0, -14, "#6d55cc", 7) +
    circle(0, -32, 18, "#7cc4ff", `opacity="0.35"`) +
    circle(0, -32, 18, "none", `stroke="#e9e3ff" stroke-width="5.5"`) +
    stroke(`M-9 ${n(-38 + glint)}Q-6 -44 0 -45`, "#ffffff", 3)
  );
}

export function globe(t: number, x: number, y: number, r = 30): string {
  let out = circle(x, y, r + 3, "#2c6fb8") + circle(x, y, r, "#4aa8ff");
  // continents drift across
  const cont = `<clipPath id="gl"><circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}"/></clipPath><g clip-path="url(#gl)">`;
  let land = "";
  for (let k = -1; k <= 1; k++) {
    const ox = x + (t * 2 * r) + k * 2 * r - r;
    land += path(
      `M${n(ox - 14)} ${n(y - 12)}q8 -8 18 -2q6 6 -2 12q-6 4 -2 10q-8 4 -14 -4q-6 -8 0 -16z`,
      "#7ef0c1",
    );
    land += path(`M${n(ox + 12)} ${n(y + 6)}q8 -4 12 4q2 8 -6 10q-8 0 -6 -14z`, "#7ef0c1");
  }
  out += cont + land + "</g>";
  // meridians that rotate
  for (let i = 0; i < 3; i++) {
    const k = (t + i / 3) % 1;
    const rx = Math.abs(Math.cos(k * Math.PI)) * r;
    out += ellipse(x, y, Math.max(0.6, rx), r, "none", `stroke="#ffffff" stroke-width="1.6" opacity="0.45"`);
  }
  out += line(x - r, y, x + r, y, "#ffffff", 1.6, `opacity="0.45"`);
  out += circle(x, y, r, "none", `stroke="#ffffff" stroke-width="2" opacity="0.6"`);
  // little satellite sparkle orbiting
  const a = t * TAU;
  out += sparkle(x + Math.cos(a) * (r + 12), y + Math.sin(a) * (r * 0.35 + 6), 5, PALETTE.goldLight);
  return out;
}

/** Sign on a stick with a pixel glyph, origin = grip. */
export function sign(glyph: string): string {
  return line(0, 8, 0, -30, "#8a6a4a", 5) + rect(-22, -60, 44, 34, "#fff1d6", 8) + rect(-22, -60, 44, 34, "none", 8, `stroke="#d9b98a" stroke-width="3"`) + pixelText(glyph, 0, -43, 4.2, "#d97757");
}

const CONFETTI = ["#ff8fb1", "#7cc4ff", "#ffd66b", "#7ef0c1", "#b9a6ff", "#ffffff"];

export function confetti(t: number, count = 18): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const seed = (i * 97) % 101;
    const x = 12 + ((i * 53) % 232);
    const speed = 1;
    const k = (t * speed + seed / 101) % 1;
    const y = -10 + k * 270;
    const sway = Math.sin((k * 3 + i) * TAU * 0.5) * 8;
    const rot = k * 720 + i * 40;
    const color = CONFETTI[i % CONFETTI.length]!;
    out += g({ x: x + sway, y, rot }, i % 3 === 0 ? circle(0, 0, 3, color) : rect(-4, -2, 8, 4, color, 1));
  }
  return out;
}

export function rainCloud(t: number, x: number, y: number): string {
  let out = "";
  for (let i = 0; i < 5; i++) {
    const k = (t * 2 + i / 5) % 1;
    const dx = x - 20 + i * 10;
    out += line(dx - k * 3, y + 10 + k * 34, dx - k * 3 - 2, y + 16 + k * 34, "#7cc4ff", 2.6, `opacity="${n(1 - k)}"`);
  }
  out += circle(x - 16, y, 13, "#6f6a99") + circle(x + 2, y - 7, 16, "#7d78a8") + circle(x + 18, y, 12, "#6f6a99") + rect(x - 28, y - 2, 56, 13, "#6f6a99", 6);
  return out;
}

export function sweatDrop(x: number, y: number, k: number): string {
  return g({ x, y: y + k * 6 }, path("M0 -7Q5 0 4 3A4 4 0 0 1 -4 3Q-5 0 0 -7Z", "#9fd8ff"), `opacity="${n(1 - k * 0.6)}"`);
}

// ---------------------------------------------------------------------------
// Pixel font (3x5) for digits and a few symbols.
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, string[]> = {
  "0": ["010", "101", "101", "101", "010"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["110", "001", "010", "100", "111"],
  "3": ["110", "001", "010", "001", "110"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "110", "001", "110"],
  "6": ["011", "100", "110", "101", "010"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["010", "101", "010", "101", "010"],
  "9": ["010", "101", "011", "001", "110"],
  "+": ["000", "010", "111", "010", "000"],
  x: ["000", "101", "010", "101", "000"],
  "?": ["111", "001", "011", "000", "010"],
  "!": ["010", "010", "010", "000", "010"],
};

/** Draw pixel text centered at (cx, cy) with pixel size px. */
export function pixelText(text: string, cx: number, cy: number, px: number, color: string): string {
  const chars = [...text];
  const width = chars.length * 4 * px - px;
  let out = "";
  chars.forEach((ch, ci) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    const ox = cx - width / 2 + ci * 4 * px;
    const oy = cy - 2.5 * px;
    glyph.forEach((row, ry) => {
      [...row].forEach((bit, rx) => {
        if (bit === "1") out += rect(ox + rx * px, oy + ry * px, px + 0.3, px + 0.3, color, px * 0.25);
      });
    });
  });
  return out;
}

export function countBadge(count: number | string, x = 14, y = 14): string {
  const label = typeof count === "string" ? count : count > 99 ? "99+" : String(count);
  const px = 4;
  const textW = [...label].length * 4 * px - px;
  const w = 30 + textW;
  // pill with a tiny agent face on the left and the count on the right
  return (
    rect(x, y, w + 4, 30, "#8f7cff", 15) +
    rect(x, y, w + 4, 30, "none", 15, `stroke="#d9d0ff" stroke-width="2"`) +
    circle(x + 15, y + 15, 9, "#ffffff") +
    circle(x + 12, y + 14.5, 1.8, PALETTE.ink) +
    circle(x + 18, y + 14.5, 1.8, PALETTE.ink) +
    pixelText(label, x + 29 + textW / 2, y + 15, px, "#ffffff")
  );
}

/** Small glowing wisp used as a placeholder subagent. */
export function wisp(color: string, blink: number): string {
  return (
    circle(0, 0, 15, color, `opacity="0.25"`) +
    circle(0, 0, 10.5, color) +
    circle(-3.4, -1, 1.6, PALETTE.ink, blink > 0.5 ? `transform="scale(1 0.2)"` : "") +
    circle(3.4, -1, 1.6, PALETTE.ink, blink > 0.5 ? `transform="scale(1 0.2)"` : "") +
    circle(-3, -4.5, 2.2, "#ffffff", `opacity="0.7"`)
  );
}

export const WISP_COLORS = ["#ff8fb1", "#7cc4ff", "#ffd66b", "#7ef0c1", "#b9a6ff", "#ffb38a", "#9ff0ff", "#f4a6ff"];
