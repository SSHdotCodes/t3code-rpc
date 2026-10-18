// Render the committed art pack into assets/art:
//   activity loops for every scene × character, orchestration fallbacks with
//   1..9 anonymous wisps, provider badges, and a manifest.
//
//   node scripts/build-assets.ts [--only scene|orbit|badges] [--jobs 4]

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BADGE_KINDS, badgeSvg } from "../src/art/badges.ts";
import { activityPath, badgePath, ORBIT_FALLBACK_CONDUCTORS, ORBIT_FALLBACK_HELPERS, ORBIT_FALLBACK_MAX, orbitFallbackPath } from "../src/art/catalog.ts";
import { CHARACTER_KINDS } from "../src/render/characters.ts";
import { encodeGif, svgToPng } from "../src/render/encode.ts";
import { ACTIVITY_SCENES, frameCount, renderFrame, type SceneSpec, timingFor } from "../src/render/scenes.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "art");
export const ART_SIZE = 320;
const ORBIT_FALLBACK_SIZE = 256;

const { values } = parseArgs({ options: { only: { type: "string" }, jobs: { type: "string", default: "4" } } });
const only = values.only;
const jobs = Math.max(1, Number(values.jobs));

interface Job {
  path: string;
  run: (file: string) => Promise<void>;
}
const queue: Job[] = [];

const gifJob = (path: string, spec: SceneSpec, size: number, fpsOverride?: number): Job => ({
  path,
  run: async (file) => {
    const { fps } = timingFor(spec);
    const useFps = fpsOverride ?? fps;
    const frames = Math.round(timingFor(spec).seconds * useFps);
    await encodeGif(frames, (i) => renderFrame(spec, i / frames, size), { size, fps: useFps, out: file });
  },
});

if (!only || only === "scene") {
  for (const scene of ACTIVITY_SCENES)
    for (const character of CHARACTER_KINDS) queue.push(gifJob(activityPath(scene, character), { scene, character }, ART_SIZE));
}
if (!only || only === "orbit") {
  for (const character of ORBIT_FALLBACK_CONDUCTORS)
    for (const helper of ORBIT_FALLBACK_HELPERS)
      for (let n = 1; n <= ORBIT_FALLBACK_MAX; n++) {
        const spec: SceneSpec = {
          scene: "orbit",
          character,
          orbiters: Array.from({ length: n }, () => helper),
          countLabel: n === ORBIT_FALLBACK_MAX ? `${n}+` : undefined,
        };
        queue.push(gifJob(orbitFallbackPath(character, helper, n), spec, ORBIT_FALLBACK_SIZE, 16));
      }
}
if (!only || only === "badges") {
  for (const kind of BADGE_KINDS)
    queue.push({ path: badgePath(kind), run: async (file) => writeFile(file, await svgToPng(badgeSvg(kind), 256)) });
}

let done = 0;
let bytes = 0;
const started = Date.now();
async function worker(): Promise<void> {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const file = join(OUT, job.path);
    await mkdir(dirname(file), { recursive: true });
    await job.run(file);
    const size = (await stat(file)).size;
    bytes += size;
    done++;
    console.log(`[${done}] ${job.path} ${(size / 1024).toFixed(0)} KB`);
  }
}
const total = queue.length;
await Promise.all(Array.from({ length: jobs }, worker));

await writeFile(
  join(OUT, "manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      size: ART_SIZE,
      orbitFallbackSize: ORBIT_FALLBACK_SIZE,
      scenes: ACTIVITY_SCENES,
      characters: CHARACTER_KINDS,
      orbitFallbackMax: ORBIT_FALLBACK_MAX,
      orbitFallbackConductors: ORBIT_FALLBACK_CONDUCTORS,
      orbitFallbackHelpers: ORBIT_FALLBACK_HELPERS,
    },
    null,
    2,
  ) + "\n",
);
console.log(`rendered ${total} files, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`);
