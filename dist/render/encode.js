// Rasterize SVG frames with resvg and encode them into a looping GIF with
// ffmpeg (single shared palette + rectangle frame-diffing keeps flat art crisp
// and files small).
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
let resvgModule = null;
async function loadResvg() {
    if (resvgModule)
        return resvgModule;
    try {
        resvgModule = await import("@resvg/resvg-js");
        return resvgModule;
    }
    catch {
        throw new Error("Rendering art needs the optional dependency @resvg/resvg-js (npm install @resvg/resvg-js).");
    }
}
export async function rasterize(svg, size) {
    const { Resvg } = await loadResvg();
    const r = new Resvg(svg, {
        fitTo: { mode: "width", value: size },
        font: { loadSystemFonts: false },
        shapeRendering: 2,
        background: "rgba(0,0,0,0)",
    });
    const img = r.render();
    return { width: img.width, height: img.height, rgba: Buffer.from(img.pixels) };
}
export async function svgToPng(svg, size) {
    const { Resvg } = await loadResvg();
    const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } });
    return Buffer.from(r.render().asPng());
}
function run(cmd, args, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => {
            stderr += d.toString();
            if (stderr.length > 20000)
                stderr = stderr.slice(-10000);
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-2000)}`));
        });
        if (input) {
            input(child.stdin).then(() => child.stdin.end(), (err) => {
                child.kill();
                reject(err);
            });
        }
        else
            child.stdin.end();
    });
}
function write(stream, chunk) {
    return new Promise((resolve, reject) => {
        const ok = stream.write(chunk, (err) => (err ? reject(err) : undefined));
        if (ok)
            resolve();
        else
            stream.once("drain", () => resolve());
    });
}
/**
 * Render `frames` SVG frames to a GIF. `frameAt(i)` returns the SVG for frame i.
 * Frames are streamed into ffmpeg so memory stays flat for long loops.
 */
export async function encodeGif(frameCount, frameAt, opts) {
    await mkdir(dirname(opts.out), { recursive: true });
    const filter = "[0:v]split[a][b];[a]palettegen=max_colors=255:stats_mode=full:reserve_transparent=0[p];" +
        "[b][p]paletteuse=dither=none:diff_mode=rectangle";
    const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        `${opts.size}x${opts.size}`,
        "-r",
        String(opts.fps),
        "-i",
        "-",
        "-filter_complex",
        filter,
        "-loop",
        "0",
        "-f",
        "gif",
        opts.out,
    ];
    await run("ffmpeg", args, async (stdin) => {
        for (let i = 0; i < frameCount; i++) {
            const frame = await rasterize(frameAt(i), opts.size);
            await write(stdin, frame.rgba);
        }
    });
}
export async function hasFfmpeg() {
    try {
        await run("ffmpeg", ["-hide_banner", "-version"]);
        return true;
    }
    catch {
        return false;
    }
}
