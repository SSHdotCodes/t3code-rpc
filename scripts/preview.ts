// Render contact sheets (one PNG per character, every scene at a few phases)
// and optionally a GIF for quick inspection.
//
//   node scripts/preview.ts [character...] [--t 0.3] [--gif scene:character] [--out preview]

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CHARACTER_KINDS, type CharacterKind } from "../src/render/characters.ts";
import { encodeGif, svgToPng } from "../src/render/encode.ts";
import { ACTIVITY_SCENES, frameCount, renderFrame, type SceneSpec, timingFor } from "../src/render/scenes.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    t: { type: "string", default: "0.3" },
    gif: { type: "string", multiple: true },
    out: { type: "string", default: "preview" },
    orbit: { type: "string", multiple: true },
  },
});

const out = values.out!;
await mkdir(out, { recursive: true });
const phase = Number(values.t);
const wantsGifs = (values.gif?.length ?? 0) + (values.orbit?.length ?? 0) > 0;
const kinds = (positionals.length ? positionals : wantsGifs ? [] : CHARACTER_KINDS) as CharacterKind[];

function inner(svg: string): string {
  return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
}

const cell = 256;
for (const kind of kinds) {
  const specs: SceneSpec[] = [
    ...ACTIVITY_SCENES.map((scene) => ({ scene, character: kind })),
    { scene: "orbit", character: kind, orbiters: ["codex", "codex", "grok", "claude", "muse"] },
  ];
  const cols = 5;
  const rows = Math.ceil(specs.length / cols);
  const body = specs
    .map((spec, i) => `<g transform="translate(${(i % cols) * cell} ${Math.floor(i / cols) * cell})">${inner(renderFrame(spec, phase))}</g>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell}" viewBox="0 0 ${cols * cell} ${rows * cell}">${body}</svg>`;
  const file = join(out, `sheet-${kind}.png`);
  await writeFile(file, await svgToPng(svg, cols * cell));
  console.log(file);
}

for (const o of values.orbit ?? []) {
  // --orbit claude:codex,codex,grok
  const [kind, list] = o.split(":");
  const orbiters = (list ?? "wisp").split(",") as SceneSpec["orbiters"];
  const spec: SceneSpec = { scene: "orbit", character: kind as CharacterKind, orbiters };
  const file = join(out, `orbit-${kind}-${(list ?? "wisp").replaceAll(",", "_")}.gif`);
  const { fps } = timingFor(spec);
  const started = Date.now();
  await encodeGif(frameCount(spec), (i) => renderFrame(spec, i / frameCount(spec), 320), { size: 320, fps, out: file });
  console.log(file, `${((await stat(file)).size / 1024).toFixed(0)} KB`, `${Date.now() - started}ms`);
}

for (const gspec of values.gif ?? []) {
  const [scene, kind] = gspec.split(":");
  const spec: SceneSpec = { scene: scene as SceneSpec["scene"], character: (kind ?? "t3") as CharacterKind };
  const file = join(out, `${scene}-${kind}.gif`);
  const { fps } = timingFor(spec);
  const started = Date.now();
  await encodeGif(frameCount(spec), (i) => renderFrame(spec, i / frameCount(spec), 320), { size: 320, fps, out: file });
  console.log(file, `${((await stat(file)).size / 1024).toFixed(0)} KB`, `${Date.now() - started}ms`);
}
