import { access, readFile } from "node:fs/promises";
import type { AppStatus } from "../types.ts";
import { resolveT3Paths, type T3Paths } from "./paths.ts";

export interface DetectOptions {
  home?: string;
  paths?: T3Paths;
  timeoutMs?: number;
  now?: number;
}

export async function detectApp(opts: DetectOptions = {}): Promise<AppStatus> {
  const paths = opts.paths ?? resolveT3Paths({ home: opts.home });
  const result: AppStatus = { running: false, pid: null, port: null, serverVersion: null, dbPath: null };
  try {
    await access(paths.dbPath);
    result.dbPath = paths.dbPath;
  } catch { /* First launch, or an unavailable state directory. */ }

  try {
    const record = JSON.parse(await readFile(paths.runtimePath, "utf8"));
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) return result;
    result.pid = record.pid;
    result.port = Number.isInteger(record.port) && record.port > 0 && record.port <= 65535 ? record.port : null;
    result.serverVersion = typeof record.serverVersion === "string" ? record.serverVersion : null;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      // EPERM still proves that this PID exists.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return result;
    }

    if (result.port !== null) {
      try {
        const response = await fetch(`http://127.0.0.1:${result.port}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
          redirect: "error",
        });
        result.running = response.ok;
        await response.body?.cancel();
      } catch { /* A live process may still be booting. */ }
    }
    const startedAt = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : NaN;
    const age = (opts.now ?? Date.now()) - startedAt;
    if (!result.running && age >= 0 && age < 60_000) result.running = true;
  } catch { /* Missing, partially replaced or malformed runtime records are normal. */ }
  return result;
}
