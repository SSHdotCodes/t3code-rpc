// Exact orchestration rings, rendered on demand and published to a public
// GitHub repo branch so Discord can fetch them. Each composition (conductor +
// helper logos + count) is rendered once, ever: the file name is a canonical
// key, so later sessions — on any machine — reuse it.
//
// While a new ring is being rendered/uploaded (a couple of seconds), callers
// get null and should show the closest pre-rendered ring instead.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { encodeGif, hasFfmpeg } from "../render/encode.js";
import { frameCount, renderFrame, timingFor } from "../render/scenes.js";
import { canonicalOrbiters, orbitKey } from "./catalog.js";
const run = promisify(execFile);
const API = "https://api.github.com";
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
export class DynamicArt {
    #opts;
    #cacheFile;
    #cache = {};
    #queue = [];
    #pending = new Set();
    #failedUntil = new Map();
    #working = false;
    #token;
    #branchReady = false;
    #available;
    #onReady = null;
    constructor(opts) {
        this.#opts = opts;
        this.#cacheFile = join(opts.home, "art-cache.json");
        try {
            this.#cache = JSON.parse(readFileSync(this.#cacheFile, "utf8"));
        }
        catch {
            this.#cache = {};
        }
    }
    /** Called whenever a new ring becomes available, so the daemon can refresh right away. */
    onReady(fn) {
        this.#onReady = fn;
    }
    /** URL of the exact ring if it's published; otherwise schedules it and returns null. */
    urlFor(conductor, orbiters, count) {
        const ring = canonicalOrbiters(orbiters).slice(0, this.#opts.maxOrbiters);
        const key = `v${this.#opts.artVersion}/${orbitKey(conductor, ring, count)}`;
        const hit = this.#cache[key];
        if (hit)
            return hit.url;
        if (this.#available === false || this.#pending.has(key))
            return null;
        if ((this.#failedUntil.get(key) ?? 0) > Date.now())
            return null;
        this.#pending.add(key);
        this.#queue.push({ key, spec: { scene: "orbit", character: conductor, orbiters: ring, count } });
        void this.#drain();
        return null;
    }
    rawUrl(key) {
        return `https://raw.githubusercontent.com/${this.#opts.repo}/${this.#opts.branch}/orbit/${key}.gif`;
    }
    async #drain() {
        if (this.#working)
            return;
        this.#working = true;
        try {
            for (let job = this.#queue.shift(); job; job = this.#queue.shift()) {
                try {
                    if (!(await this.#checkAvailable())) {
                        this.#pending.clear();
                        this.#queue = [];
                        return;
                    }
                    const url = await this.#produce(job.key, job.spec);
                    this.#cache[job.key] = { url, at: Date.now() };
                    await mkdir(this.#opts.home, { recursive: true });
                    await writeFile(this.#cacheFile, JSON.stringify(this.#cache, null, 2));
                    this.#opts.logger.info(`art: published ${job.key}`);
                    this.#onReady?.();
                }
                catch (err) {
                    this.#failedUntil.set(job.key, Date.now() + RETRY_AFTER_FAILURE_MS);
                    this.#opts.logger.warn(`art: could not publish ${job.key}: ${err.message}`);
                }
                finally {
                    this.#pending.delete(job.key);
                }
            }
        }
        finally {
            this.#working = false;
        }
    }
    async #checkAvailable() {
        if (this.#available !== undefined)
            return this.#available;
        const problems = [];
        if (!(await hasFfmpeg()))
            problems.push("ffmpeg not found on PATH");
        try {
            await import("@resvg/resvg-js");
        }
        catch {
            problems.push("@resvg/resvg-js is not installed");
        }
        if (!(await this.#getToken()))
            problems.push("no GitHub token (run `gh auth login` or set GITHUB_TOKEN)");
        this.#available = problems.length === 0;
        if (!this.#available)
            this.#opts.logger.warn(`art: exact rings disabled — ${problems.join("; ")}. Using pre-rendered rings.`);
        return this.#available;
    }
    async #getToken() {
        if (this.#token !== undefined)
            return this.#token;
        const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
        if (env)
            return (this.#token = env);
        try {
            const { stdout } = await run("gh", ["auth", "token"], { timeout: 5000 });
            this.#token = stdout.trim() || null;
        }
        catch {
            this.#token = null;
        }
        return this.#token;
    }
    async #gh(method, path, body) {
        const token = await this.#getToken();
        const res = await fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "t3code-rpc",
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        }
        catch {
            json = text;
        }
        return { status: res.status, json };
    }
    /** Create the art branch as an orphan (no shared history with main) if it's missing. */
    async #ensureBranch() {
        if (this.#branchReady)
            return;
        const { repo, branch } = this.#opts;
        const existing = await this.#gh("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
        if (existing.status === 200) {
            this.#branchReady = true;
            return;
        }
        if (existing.status !== 404)
            throw new Error(`GitHub branch lookup failed (${existing.status})`);
        const readme = "# art cache\n\nOrchestration rings rendered on demand by t3code-rpc. Safe to delete; they are re-rendered when needed.\n";
        const blob = await this.#gh("POST", `/repos/${repo}/git/blobs`, { content: readme, encoding: "utf-8" });
        const tree = await this.#gh("POST", `/repos/${repo}/git/trees`, { tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blob.json?.sha }] });
        const commit = await this.#gh("POST", `/repos/${repo}/git/commits`, { message: "art cache", tree: tree.json?.sha, parents: [] });
        const ref = await this.#gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.json?.sha });
        if (ref.status !== 201 && ref.status !== 422)
            throw new Error(`could not create branch ${branch} (${ref.status})`);
        this.#branchReady = true;
    }
    async #produce(key, spec) {
        const { repo, branch, home } = this.#opts;
        const remotePath = `orbit/${key}.gif`;
        const url = this.rawUrl(key);
        await this.#ensureBranch();
        // Someone (maybe another machine) already rendered it? Ask the API, not the raw CDN,
        // so we never cache a 404 at the CDN for a file we're about to create.
        const exists = await this.#gh("GET", `/repos/${repo}/contents/${remotePath}?ref=${encodeURIComponent(branch)}`);
        if (exists.status !== 200) {
            const size = this.#opts.size ?? 320;
            const file = join(home, "art", `${key.replaceAll("/", "_")}.gif`);
            const frames = frameCount(spec);
            const started = Date.now();
            await encodeGif(frames, (i) => renderFrame(spec, i / frames, size), { size, fps: timingFor(spec).fps, out: file });
            this.#opts.logger.debug(`art: rendered ${key} in ${Date.now() - started}ms`);
            const content = (await readFile(file)).toString("base64");
            const put = await this.#gh("PUT", `/repos/${repo}/contents/${remotePath}`, { message: `art: ${key}`, content, branch });
            if (put.status !== 201 && put.status !== 200 && put.status !== 422) {
                throw new Error(`upload failed (${put.status}): ${typeof put.json === "object" ? put.json?.message : put.json}`);
            }
        }
        // Wait until the raw CDN serves it, so Discord's first fetch succeeds.
        for (let i = 0; i < 20; i++) {
            const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) }).catch(() => null);
            if (head?.ok)
                return url;
            await new Promise((r) => setTimeout(r, 1500));
        }
        throw new Error("uploaded but not served by raw.githubusercontent.com yet");
    }
}
