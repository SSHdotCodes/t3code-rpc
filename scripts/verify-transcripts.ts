#!/usr/bin/env node
// Read-only correctness gate against T3's own scan output. No transcript text is logged.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  decodeTranscriptCache, dedupeWithinFile, isTranscriptProvider,
  readTranscriptRecords, transcriptFormats,
  type TranscriptProvider, type TranscriptUsageFormat, type UsageRecord,
} from "../src/t3/transcripts.ts";

const { values } = parseArgs({ options: { cache: { type: "string" } } });
const cachePath = resolve(values.cache ?? join(homedir(), ".t3", "userdata", "usage-scan-cache-v5.json"));
const document = JSON.parse(await readFile(cachePath, "utf8"));
const cache = decodeTranscriptCache(document);
const providers: TranscriptProvider[] = ["claude", "codex", "grok", "pi"];
const results = Object.fromEntries(providers.map((p) => [p, { files: 0, records: 0, mismatches: 0, changed: 0, missing: 0 }])) as
  Record<TranscriptProvider, { files: number; records: number; mismatches: number; changed: number; missing: number }>;
let diagnostics = 0;
const start = performance.now();
const queue = Object.entries(document.files as Record<string, { p: string; s: number; m: number }>).values();
await Promise.all(Array.from({ length: 4 }, async () => {
  for (const [path, raw] of queue) {
    if (!isTranscriptProvider(raw.p)) continue;
    const result = results[raw.p];
    let before;
    try { before = await stat(path); } catch { result.missing++; continue; }
    if (before.size !== raw.s || before.mtimeMs !== raw.m) { result.changed++; continue; }
    const expected = cache.files.get(path);
    const actual = await readTranscriptRecords(path, transcriptFormats[raw.p] as TranscriptUsageFormat<unknown>);
    let after;
    try { after = await stat(path); } catch { result.changed++; continue; }
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) { result.changed++; continue; }
    result.files++;
    if (!expected || !actual) {
      result.mismatches++;
      if (diagnostics++ < 10) console.error(`${raw.p}: ${expected ? "read failure" : "cache decode failure"}: ${path}`);
      continue;
    }
    const seen = new Set<string>();
    const records = dedupeWithinFile(actual.records, seen);
    const tail = dedupeWithinFile(actual.tailRecords, seen);
    for (const [got, want] of [[records, expected.records], [tail, expected.tailRecords]] as const) {
      result.records += Math.max(got.length, want.length);
      for (let i = 0; i < Math.max(got.length, want.length); i++) {
        if (isDeepStrictEqual(got[i], want[i])) continue;
        result.mismatches++;
        if (diagnostics++ < 10) {
          const keys = new Set([...Object.keys(got[i] ?? {}), ...Object.keys(want[i] ?? {})]);
          const fields = [...keys].filter((key) => !isDeepStrictEqual(got[i]?.[key as keyof UsageRecord], want[i]?.[key as keyof UsageRecord]));
          console.error(`${raw.p}: row ${i}, fields ${fields.join(", ")}: ${path}`);
        }
      }
    }
    if (!isDeepStrictEqual(actual.position, expected.position)) {
      result.mismatches++;
      if (diagnostics++ < 10) console.error(`${raw.p}: parse position/state mismatch: ${path}`);
    }
  }
}));
console.log("provider  files checked  records compared  mismatches  changed/skipped  missing");
for (const provider of providers) {
  const r = results[provider];
  console.log(`${provider.padEnd(8)}  ${String(r.files).padStart(11)}  ${String(r.records).padStart(16)}  ${String(r.mismatches).padStart(10)}  ${String(r.changed).padStart(15)}  ${String(r.missing).padStart(7)}`);
}
console.log(`elapsed: ${(performance.now() - start).toFixed(1)} ms`);
if (Object.values(results).some((r) => r.mismatches > 0)) process.exitCode = 1;
