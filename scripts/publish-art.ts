// Render the art pack and publish it to an orphan branch (default: `art`),
// keeping `main` and npm installs small.
//
//   node scripts/publish-art.ts [--branch art] [--remote origin] [--jobs 6] [--dry-run]

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    branch: { type: "string", default: "art" },
    remote: { type: "string", default: "origin" },
    jobs: { type: "string", default: "6" },
    "dry-run": { type: "boolean", default: false },
  },
});

const branch = values.branch!;
const remote = values.remote!;
const dir = await mkdtemp(join(tmpdir(), "t3code-rpc-art-"));

try {
  const { stdout: remoteUrl } = await run("git", ["remote", "get-url", remote], { cwd: ROOT });
  console.log(`Rendering art pack into ${dir}…`);
  await run(process.execPath, [join(ROOT, "scripts", "build-assets.ts"), "--out", dir, "--jobs", values.jobs!], {
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });
  await writeFile(
    join(dir, "README.md"),
    "# t3code-rpc art pack\n\nPre-rendered animated GIFs and badges hosted for Discord Rich Presence. Regenerated from `main` via `npm run assets:publish`.\n",
  );
  await run("git", ["init", "-b", branch], { cwd: dir });
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-m", "Update pre-rendered art pack"], { cwd: dir });
  if (values["dry-run"]) {
    console.log(`Dry run complete (orphan commit ready on branch ${branch} in ${dir}).`);
  } else {
    await run("git", ["push", "--force", remoteUrl.trim(), `HEAD:refs/heads/${branch}`], { cwd: dir });
    console.log(`Published orphan branch ${branch} to ${remote}.`);
  }
} finally {
  if (!values["dry-run"]) await rm(dir, { recursive: true, force: true });
}
