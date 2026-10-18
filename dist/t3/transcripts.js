// Faithful zero-dependency port of pingdotgg/t3code 16918b57 usage readers.
// Only usage metadata survives a read. Transcript/cache files are opened read-only.
import * as fs from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createUsageJsonReader } from "./transcriptJson.js";
export const tokenCount = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
export const totalTokens = (t) => t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
export function parseTimestampMs(value) {
    if (typeof value !== "string")
        return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}
const orEmpty = (record) => record === null ? [] : [record];
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * T3 Code writes one record per assistant *content block*, and every one of those records repeats
 * the same complete `usage` object for the parent message. Summing them overcounts by roughly
 * 2.4x on a real workload, so the caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    return parseClaudeRecord(parsed);
}
function parseClaudeRecord(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const record = parsed;
    if (record["type"] !== "assistant")
        return null;
    const message = record["message"];
    if (typeof message !== "object" || message === null)
        return null;
    const messageRecord = message;
    const usage = messageRecord["usage"];
    if (typeof usage !== "object" || usage === null)
        return null;
    const usageRecord = usage;
    const timestampMs = parseTimestampMs(record["timestamp"]);
    if (timestampMs === null)
        return null;
    const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
    if (model.length === 0)
        return null;
    const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
    const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
    const dedupeKey = messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;
    const cost = record["costUSD"];
    return {
        provider: "claude",
        timestampMs,
        model,
        sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
        totals: {
            uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
            cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
            cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
            outputTokens: tokenCount(usageRecord["output_tokens"]),
            // Anthropic folds thinking tokens into output and does not break them out.
            reasoningTokens: 0,
        },
        reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
        speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
        dedupeKey,
    };
}
export const claudeUsageFormat = {
    selectFields: {
        type: true,
        timestamp: true,
        requestId: true,
        sessionId: true,
        costUSD: true,
        message: { id: true, model: true, usage: true },
    },
    usageMarkers: ['"usage"'],
    parseLine: (line) => orEmpty(parseClaudeLine(line)),
    parseProjected: (projected) => orEmpty(parseClaudeRecord(projected)),
};
function decodeCodexState(value) {
    if (!object(value) || typeof value.model !== "string" || typeof value.sessionId !== "string" ||
        !["standard", "fast", "ultrafast"].includes(String(value.speed)) ||
        !(value.lastUsageSignature === null || typeof value.lastUsageSignature === "string") ||
        typeof value.sawSessionMeta !== "boolean" || typeof value.suppressingForkCopies !== "boolean" ||
        typeof value.forkCopyAnchorMs !== "number" || !Number.isFinite(value.forkCopyAnchorMs))
        return undefined;
    return { model: value.model, speed: value.speed, sessionId: value.sessionId,
        lastUsageSignature: value.lastUsageSignature, sawSessionMeta: value.sawSessionMeta,
        suppressingForkCopies: value.suppressingForkCopies, forkCopyAnchorMs: value.forkCopyAnchorMs };
}
export function initialCodexScanState() {
    return {
        model: "",
        speed: "standard",
        sessionId: "",
        lastUsageSignature: null,
        sawSessionMeta: false,
        suppressingForkCopies: false,
        forkCopyAnchorMs: 0,
    };
}
/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant. Those copies are written in one
 * synchronous burst (observed gaps 0-40ms), while the child's first genuine
 * usage event only lands after a real model turn (observed 5s+).
 */
const FORK_COPY_MAX_GAP_MS = 1000;
function isForkedSessionMeta(payload) {
    if (typeof payload["forked_from_id"] === "string")
        return true;
    const source = payload["source"];
    if (typeof source !== "object" || source === null)
        return false;
    const subagent = source["subagent"];
    if (typeof subagent !== "object" || subagent === null)
        return false;
    const spawn = subagent["thread_spawn"];
    if (typeof spawn !== "object" || spawn === null)
        return false;
    return typeof spawn["parent_thread_id"] === "string";
}
/**
 * Deltas come from `last_token_usage`. Summing those across a session reconciles with the session's
 * final `total_token_usage`, provided consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line, state) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    return parseCodexRecord(parsed, state);
}
function parseCodexRecord(parsed, state) {
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const record = parsed;
    const payload = record["payload"];
    if (typeof payload !== "object" || payload === null)
        return null;
    const payloadRecord = payload;
    const payloadType = payloadRecord["type"];
    if (record["type"] === "session_meta") {
        // Only the first meta describes this file's own session. A forked rollout
        // repeats the ancestors' metas right after it; letting those through would
        // reassign every subsequent record to an ancestor session.
        if (state.sawSessionMeta)
            return null;
        state.sawSessionMeta = true;
        const id = payloadRecord["id"] ?? payloadRecord["session_id"];
        if (typeof id === "string")
            state.sessionId = id;
        const metaTimestampMs = parseTimestampMs(record["timestamp"]);
        if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
            state.suppressingForkCopies = true;
            state.forkCopyAnchorMs = metaTimestampMs;
        }
        return null;
    }
    if (record["type"] === "turn_context") {
        if (typeof payloadRecord["model"] === "string")
            state.model = payloadRecord["model"];
        return null;
    }
    if (payloadType === "thread_settings_applied") {
        const settings = payloadRecord["thread_settings"];
        if (typeof settings === "object" && settings !== null) {
            state.speed = codexSpeed(settings["service_tier"]);
        }
        return null;
    }
    if (payloadType !== "token_count")
        return null;
    const info = payloadRecord["info"];
    if (typeof info !== "object" || info === null)
        return null;
    const last = info["last_token_usage"];
    if (typeof last !== "object" || last === null)
        return null;
    const lastRecord = last;
    // Only an event that is otherwise eligible may consume the duplicate
    // signature. A token_count arriving before its turn_context (no model yet)
    // must not poison it, or the re-emitted copy after the model is known would
    // be skipped as a duplicate and those tokens never counted.
    const timestampMs = parseTimestampMs(record["timestamp"]);
    if (timestampMs === null)
        return null;
    if (state.model.length === 0)
        return null;
    // Codex re-emits an unchanged token_count on some stream boundaries. Summing
    // those would double count, so identical consecutive payloads are skipped.
    const signature = JSON.stringify(lastRecord);
    if (signature === state.lastUsageSignature)
        return null;
    state.lastUsageSignature = signature;
    if (state.suppressingForkCopies) {
        if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
            state.forkCopyAnchorMs = timestampMs;
            return null;
        }
        state.suppressingForkCopies = false;
    }
    const inputTokens = tokenCount(lastRecord["input_tokens"]);
    const cachedInputTokens = tokenCount(lastRecord["cached_input_tokens"]);
    const cacheCreationTokens = tokenCount(lastRecord["cache_write_input_tokens"]);
    const outputTokens = tokenCount(lastRecord["output_tokens"]);
    const totals = {
        // Codex reports `input_tokens` inclusive of the cached portion.
        uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
        // Reported inside output_tokens, surfaced separately for the token mix.
        reasoningTokens: Math.min(outputTokens, tokenCount(lastRecord["reasoning_output_tokens"])),
    };
    if (totalTokens(totals) === 0)
        return null;
    return {
        provider: "codex",
        timestampMs,
        model: state.model,
        sessionId: state.sessionId,
        totals,
        reportedCostUsd: null,
        speed: state.speed,
        dedupeKey: null,
    };
}
/**
 * Codex omits the field when no tier was requested, which bills as standard, as
 * do `default` and `standard`. `fast` is accepted as an alias of `priority`.
 */
function codexSpeed(serviceTier) {
    if (serviceTier === "priority" || serviceTier === "fast")
        return "fast";
    if (serviceTier === "ultrafast")
        return "ultrafast";
    return "standard";
}
export const codexUsageFormat = {
    selectFields: {
        type: true,
        timestamp: true,
        payload: {
            type: true,
            id: true,
            session_id: true,
            model: true,
            thread_settings: { service_tier: true },
            forked_from_id: true,
            source: { subagent: { thread_spawn: { parent_thread_id: true } } },
            info: { last_token_usage: true },
        },
    },
    // `turn_context`, `thread_settings_applied` and `session_meta` lines hold no
    // usage, but they carry the model, tier and session the reducer needs.
    usageMarkers: ['"token_count"', '"turn_context"', '"thread_settings_applied"', '"session_meta"'],
    parseLine: (line, state) => orEmpty(parseCodexLine(line, state)),
    parseProjected: (projected, state) => orEmpty(parseCodexRecord(projected, state)),
    state: { initial: initialCodexScanState, decode: decodeCodexState },
    // A rollout that moved after it was read leaves a copy in both places.
    sharedSessionsAcrossFiles: true,
};
/**
 * Grok reports cost in integer ticks where `1 USD = 10^10` ticks. See Grok
 * headless `total_cost_usd_ticks`.
 */
export const GROK_COST_USD_TICKS_PER_DOLLAR = 10_000_000_000;
function grokCostTicksToUsd(ticks) {
    if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0)
        return null;
    return ticks / GROK_COST_USD_TICKS_PER_DOLLAR;
}
function readGrokUsageTotals(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const record = value;
    return {
        inputTokens: tokenCount(record["inputTokens"]),
        outputTokens: tokenCount(record["outputTokens"]),
        cachedReadTokens: tokenCount(record["cachedReadTokens"]),
        cacheCreationTokens: tokenCount(record["cacheCreationTokens"]),
        reasoningTokens: tokenCount(record["reasoningTokens"]),
        costUsdTicks: typeof record["costUsdTicks"] === "number" && Number.isFinite(record["costUsdTicks"])
            ? record["costUsdTicks"]
            : null,
    };
}
function grokTotalsToUsage(totals) {
    const cachedInputTokens = totals.cachedReadTokens;
    const cacheCreationTokens = totals.cacheCreationTokens;
    // Grok reports `inputTokens` inclusive of the cached portion, matching Codex.
    const uncachedInputTokens = Math.max(0, totals.inputTokens - cachedInputTokens - cacheCreationTokens);
    const outputTokens = totals.outputTokens;
    return {
        uncachedInputTokens,
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens: Math.min(outputTokens, totals.reasoningTokens),
    };
}
export function parseGrokLine(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return [];
    }
    return parseGrokRecord(parsed);
}
function parseGrokRecord(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return [];
    const record = parsed;
    const params = record["params"];
    if (typeof params !== "object" || params === null)
        return [];
    const paramsRecord = params;
    const update = paramsRecord["update"];
    if (typeof update !== "object" || update === null)
        return [];
    const updateRecord = update;
    if (updateRecord["sessionUpdate"] !== "turn_completed")
        return [];
    const usage = updateRecord["usage"];
    if (typeof usage !== "object" || usage === null)
        return [];
    const usageRecord = usage;
    const sessionId = typeof paramsRecord["sessionId"] === "string" ? paramsRecord["sessionId"] : "";
    const promptId = typeof updateRecord["prompt_id"] === "string" ? updateRecord["prompt_id"] : null;
    const meta = paramsRecord["_meta"];
    let timestampMs = null;
    if (typeof meta === "object" && meta !== null) {
        const agentTimestampMs = meta["agentTimestampMs"];
        if (typeof agentTimestampMs === "number" && Number.isFinite(agentTimestampMs)) {
            timestampMs = agentTimestampMs;
        }
    }
    if (timestampMs === null) {
        const timestamp = record["timestamp"];
        if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
            timestampMs = timestamp > 1e12 ? timestamp : timestamp * 1000;
        }
    }
    if (timestampMs === null)
        return [];
    const topLevel = readGrokUsageTotals(usageRecord);
    if (topLevel === null)
        return [];
    const modelUsage = usageRecord["modelUsage"];
    const modelEntries = [];
    if (typeof modelUsage === "object" && modelUsage !== null) {
        for (const [model, raw] of Object.entries(modelUsage)) {
            if (model.length === 0)
                continue;
            const totals = readGrokUsageTotals(raw);
            if (totals === null)
                continue;
            modelEntries.push({ model, totals });
        }
    }
    if (modelEntries.length === 0) {
        if (totalTokens(grokTotalsToUsage(topLevel)) === 0)
            return [];
        return [
            {
                provider: "grok",
                timestampMs,
                model: "grok",
                sessionId,
                totals: grokTotalsToUsage(topLevel),
                reportedCostUsd: grokCostTicksToUsd(topLevel.costUsdTicks),
                speed: "standard",
                // No prompt id means we cannot tell two same-second updates apart.
                dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:grok`,
            },
        ];
    }
    const topLevelCostUsd = grokCostTicksToUsd(topLevel.costUsdTicks);
    let usedTickedCostUsd = 0;
    let untickedTokenDenominator = 0;
    for (const entry of modelEntries) {
        const tokens = totalTokens(grokTotalsToUsage(entry.totals));
        if (tokens === 0)
            continue;
        if (entry.totals.costUsdTicks !== null) {
            usedTickedCostUsd += grokCostTicksToUsd(entry.totals.costUsdTicks) ?? 0;
        }
        else {
            untickedTokenDenominator += tokens;
        }
    }
    const remainingCostUsd = topLevelCostUsd === null ? null : Math.max(0, topLevelCostUsd - usedTickedCostUsd);
    const results = [];
    for (const entry of modelEntries) {
        const totals = grokTotalsToUsage(entry.totals);
        if (totalTokens(totals) === 0)
            continue;
        let reportedCostUsd = grokCostTicksToUsd(entry.totals.costUsdTicks);
        if (reportedCostUsd === null && remainingCostUsd !== null && untickedTokenDenominator > 0) {
            reportedCostUsd = remainingCostUsd * (totalTokens(totals) / untickedTokenDenominator);
        }
        results.push({
            provider: "grok",
            timestampMs,
            model: entry.model,
            sessionId,
            totals,
            reportedCostUsd,
            speed: "standard",
            dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${entry.model}`,
        });
    }
    return results;
}
export const grokUsageFormat = {
    selectFields: {
        timestamp: true,
        params: {
            sessionId: true,
            _meta: { agentTimestampMs: true },
            update: { sessionUpdate: true, prompt_id: true, usage: true },
        },
    },
    usageMarkers: ['"turn_completed"'],
    parseLine: (line) => parseGrokLine(line),
    parseProjected: (projected) => parseGrokRecord(projected),
};
function decodePiState(value) {
    return object(value) && typeof value.sessionId === "string" ? { sessionId: value.sessionId } : undefined;
}
const nonempty = (value) => typeof value === "string" && value.length > 0;
// Same acceptance rules as upstream Effect Schema, including optional cost/responseModel validation.
function decodePiEntry(value) {
    if (!object(value) || !nonempty(value.id))
        return undefined;
    if (value.type === "session")
        return { type: "session", id: value.id };
    if (typeof value.timestamp !== "string")
        return undefined;
    const source = value.type === "message" ? value.message : value;
    if (!object(source) || !object(source.usage))
        return undefined;
    const usage = source.usage;
    if (usage.cost !== undefined && (!object(usage.cost) || !("total" in usage.cost)))
        return undefined;
    const modelValid = nonempty(source.provider) && nonempty(source.model);
    if (value.type === "message") {
        if (source.role !== "toolResult" && !(source.role === "assistant" && modelValid &&
            (source.responseModel === undefined || nonempty(source.responseModel))))
            return undefined;
    }
    else if (value.type === "usage") {
        if (!modelValid)
            return undefined;
    }
    else if (value.type !== "compaction" && value.type !== "branch_summary")
        return undefined;
    const identity = { id: value.id, timestamp: value.timestamp };
    const selectedUsage = {
        ...Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "reasoning"]
            .filter((key) => Object.hasOwn(usage, key)).map((key) => [key, usage[key]])),
        ...(object(usage.cost) ? { cost: { total: usage.cost.total } } : {}),
    };
    const model = { provider: source.provider, model: source.model };
    if (value.type === "message")
        return {
            ...identity, type: "message", message: source.role === "toolResult"
                ? { role: "toolResult", usage: selectedUsage }
                : { role: "assistant", ...model, usage: selectedUsage,
                    ...(source.responseModel === undefined ? {} : { responseModel: source.responseModel }) },
        };
    if (value.type === "usage")
        return { ...identity, type: "usage", ...model, usage: selectedUsage };
    return { ...identity, type: value.type, usage: selectedUsage };
}
function parseRecord(parsed, state) {
    const entry = decodePiEntry(parsed);
    if (entry === undefined)
        return [];
    if (entry.type === "session") {
        state.sessionId = entry.id;
        return [];
    }
    const timestampMs = parseTimestampMs(entry.timestamp);
    if (timestampMs === null)
        return [];
    const source = entry.type === "message" ? entry.message : entry;
    const usage = source.usage;
    // Pi's auxiliary tool and summary records carry no model attribution. Match
    // Pi's own breakdown rather than assigning them to the conversation model.
    const rateModel = "model" in source
        ? "responseModel" in source
            ? (source.responseModel ?? source.model)
            : source.model
        : undefined;
    const model = "provider" in source ? `${source.provider}/${rateModel}` : "Tools/summaries";
    const outputTokens = tokenCount(usage.output);
    const totals = {
        // Pi's input/cache counters are already disjoint.
        uncachedInputTokens: tokenCount(usage.input),
        cachedInputTokens: tokenCount(usage.cacheRead),
        cacheCreationTokens: tokenCount(usage.cacheWrite),
        outputTokens,
        reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning)),
    };
    const cost = usage.cost?.total;
    // Pi defaults omitted catalog rates to zero. Let shared pricing estimate
    // API-equivalent cost when the transcript has no positive cost estimate.
    const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
    if (totalTokens(totals) === 0 && reportedCostUsd === null)
        return [];
    return [
        {
            provider: "pi",
            timestampMs,
            model,
            ...(rateModel === undefined ? {} : { rateModel }),
            sessionId: state.sessionId,
            totals,
            reportedCostUsd,
            speed: "standard",
            // Forks copy entries verbatim, including ID/timestamp. Entry IDs are only
            // eight random hex digits, so retain timestamp/model to avoid collisions
            // across unrelated sessions.
            dedupeKey: JSON.stringify(["pi", entry.id, entry.timestamp, model]),
        },
    ];
}
export const piUsageFormat = {
    selectFields: {
        type: true,
        id: true,
        timestamp: true,
        provider: true,
        model: true,
        usage: true,
        message: { role: true, provider: true, model: true, responseModel: true, usage: true },
    },
    usageMarkers: ['"usage"', '"session"'],
    parseLine: (line, state) => {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return [];
        }
        return parseRecord(parsed, state);
    },
    parseProjected: parseRecord,
    state: { initial: () => ({ sessionId: "" }), decode: decodePiState },
};
export const GUARD_LENGTH = 64;
const STREAMING_THRESHOLD_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const STAT_CONCURRENCY = 32;
const CARRIAGE_RETURN = 0x0d;
function fnv1a(buffer) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < buffer.length; index += 1) {
        hash ^= buffer[index];
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
/**
 * Grok sessions also ship multi-megabyte `chat_history` and `events` logs that
 * never carry usage, so the basename filter keeps a cold scan off those files.
 * Results keep `readdir` order, which the aggregator's first-seen dedupe relies
 * on.
 */
export async function listTranscriptFiles(root, sinceMs, options) {
    const fileName = options?.fileName;
    const candidates = [];
    let failedPaths = 0;
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            failedPaths += 1;
            return;
        }
        for (const entry of entries) {
            const child = join(dir, entry.name);
            if (entry.isDirectory())
                await walk(child);
            else if (fileName !== undefined ? entry.name === fileName : entry.name.endsWith(".jsonl")) {
                candidates.push(child);
            }
        }
    };
    await walk(root);
    const found = Array.from({ length: candidates.length });
    const queue = candidates.entries();
    const statQueued = async () => {
        for (const [index, path] of queue) {
            try {
                const stats = await fs.stat(path);
                if (stats.mtimeMs >= sinceMs) {
                    found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
                }
            }
            catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                    failedPaths += 1;
                }
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued));
    return { files: found.filter((file) => file !== undefined), failedPaths };
}
export async function readDirectoryVolumeId(path) {
    try {
        const stats = await fs.stat(path);
        return `${stats.dev}:${stats.ino}`;
    }
    catch {
        return "";
    }
}
async function guardMatches(handle, position) {
    if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH)
        return false;
    try {
        const window = Buffer.alloc(position.guardLength);
        const { bytesRead } = await handle.read(window, 0, position.guardLength, position.resumeOffset - position.guardLength);
        return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
    }
    catch {
        return false;
    }
}
/**
 * Several would be one pass over the line each, so they are matched together as
 * one alternation over the line's latin1 view instead: latin1 maps every byte
 * to one character without validating it, so an ASCII marker matches exactly
 * where its bytes do.
 */
export function transcriptLineGate(markers) {
    if (markers.length === 1) {
        const marker = Buffer.from(markers[0]);
        return (line) => line.includes(marker);
    }
    const pattern = new RegExp(markers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
    return (line) => pattern.test(line.toString("latin1"));
}
/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 */
export async function readTranscriptRecords(filePath, format, resumeFrom, options) {
    const streamingThresholdBytes = options?.streamingThresholdBytes ?? STREAMING_THRESHOLD_BYTES;
    let handle;
    try {
        handle = await fs.open(filePath, "r");
    }
    catch {
        return null;
    }
    try {
        const codec = format.state;
        const decodeState = codec?.decode;
        const encodeState = codec === undefined ? undefined : (value) => structuredClone(value);
        let state = codec === undefined ? undefined : codec.initial();
        let resumed = false;
        let start = 0;
        const savedState = resumeFrom === undefined || decodeState === undefined || resumeFrom.state === null
            ? undefined
            : decodeState(resumeFrom.state);
        if (resumeFrom !== undefined &&
            resumeFrom.resumeOffset > 0 &&
            (codec === undefined || savedState !== undefined) &&
            (await guardMatches(handle, resumeFrom))) {
            if (savedState !== undefined)
                state = savedState;
            start = resumeFrom.resumeOffset;
            resumed = true;
        }
        const toLineString = (lineBuffer) => {
            const content = lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
                ? lineBuffer.subarray(0, -1)
                : lineBuffer;
            return content.toString("utf8");
        };
        const mightCarryUsage = transcriptLineGate(format.usageMarkers);
        const parseLine = (lineBuffer, lineState, out) => {
            if (!mightCarryUsage(lineBuffer))
                return;
            for (const record of format.parseLine(toLineString(lineBuffer), lineState))
                out.push(record);
        };
        const records = [];
        let resumeOffset = start;
        let scanOffset = start;
        let pendingChunks = [];
        let pendingBytes = 0;
        let streaming;
        let decoder;
        const append = (segment) => {
            if (!streaming && pendingBytes + segment.length <= streamingThresholdBytes) {
                if (segment.length > 0)
                    pendingChunks.push(segment);
                pendingBytes += segment.length;
                return;
            }
            if (!streaming) {
                // Usage has no import-history budget: retain all selected usage fields,
                // regardless of the size of the surrounding unselected tool content.
                streaming = createUsageJsonReader(format.selectFields);
                decoder = new StringDecoder("utf8");
                for (const pending of pendingChunks)
                    streaming.write(decoder.write(pending));
                pendingChunks = [];
                pendingBytes = 0;
            }
            streaming.write(decoder.write(segment));
        };
        const finish = (lineState, out) => {
            if (streaming) {
                streaming.write(decoder.end());
                const projected = streaming.finish();
                for (const record of format.parseProjected(projected, lineState))
                    out.push(record);
            }
            else if (pendingBytes > 0) {
                const line = pendingChunks.length === 1
                    ? pendingChunks[0]
                    : Buffer.concat(pendingChunks, pendingBytes);
                parseLine(line, lineState, out);
            }
            pendingChunks = [];
            pendingBytes = 0;
            streaming = undefined;
            decoder = undefined;
        };
        const stream = handle.createReadStream({
            start,
            autoClose: false,
            highWaterMark: 256 * 1024,
        });
        for await (const chunk of stream) {
            let lineStart = 0;
            while (lineStart < chunk.length) {
                const newlineIndex = chunk.indexOf(NEWLINE, lineStart);
                if (newlineIndex === -1) {
                    append(chunk.subarray(lineStart));
                    break;
                }
                if (!streaming && pendingBytes === 0) {
                    parseLine(chunk.subarray(lineStart, newlineIndex), state, records);
                }
                else {
                    append(chunk.subarray(lineStart, newlineIndex));
                    finish(state, records);
                }
                lineStart = newlineIndex + 1;
                resumeOffset = scanOffset + lineStart;
            }
            scanOffset += chunk.length;
        }
        // The unfinished tail parses against a copy, so the saved state stays at
        // `resumeOffset` and the next scan replays the tail from it.
        const encodedState = encodeState === undefined ? null : encodeState(state);
        const tailRecords = [];
        finish(decodeState === undefined ? state : decodeState(encodedState), tailRecords);
        const guardLength = Math.min(GUARD_LENGTH, resumeOffset);
        let guardHash = 0;
        if (guardLength > 0) {
            const window = Buffer.alloc(guardLength);
            await handle.read(window, 0, guardLength, resumeOffset - guardLength);
            guardHash = fnv1a(window);
        }
        return {
            records,
            tailRecords,
            position: {
                resumeOffset,
                guardLength,
                guardHash,
                state: encodedState,
            },
            resumed,
        };
    }
    catch {
        return null;
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
export const transcriptFormats = {
    claude: claudeUsageFormat,
    codex: codexUsageFormat,
    grok: grokUsageFormat,
    pi: piUsageFormat,
};
export const isTranscriptProvider = (value) => Object.hasOwn(transcriptFormats, value);
const SPEEDS = ["standard", "fast", "ultrafast"];
/** Decode the same v5 intern tables, metadata, state, and row validation as T3. */
export function decodeTranscriptCache(document) {
    const files = new Map();
    const sources = [];
    if (!object(document) || document.version !== 5)
        return { files, sources };
    if (object(document.sources)) {
        const seen = new Set();
        for (const [key, source] of Object.entries(document.sources)) {
            const provider = key.split("\0")[0];
            if (!isTranscriptProvider(provider) || !object(source) || typeof source.dir !== "string")
                continue;
            const id = `${provider}\0${source.dir}`;
            if (!seen.has(id))
                sources.push({ provider, dir: source.dir, configuredDir: key.slice(provider.length + 1) });
            seen.add(id);
        }
    }
    const models = document.models;
    const sessions = document.sessions;
    if (!Array.isArray(models) || !models.every((v) => typeof v === "string") ||
        !Array.isArray(sessions) || !sessions.every((v) => typeof v === "string") || !object(document.files))
        return { files, sources };
    const decodeRecords = (rows, provider) => {
        const records = [];
        for (const row of rows) {
            if (!Array.isArray(row) || row.length < 11)
                return undefined;
            const [ts, mi, si, uncached, cached, write, output, reasoning, key, cost, speedIndex, ri] = row;
            const model = typeof mi === "number" ? models[mi] : undefined;
            const rateModel = typeof ri === "number" ? models[ri] : undefined;
            const speed = typeof speedIndex === "number" ? SPEEDS[speedIndex] : undefined;
            if (typeof ts !== "number" || !Number.isFinite(ts) || model === undefined ||
                (ri != null && rateModel === undefined) || ![uncached, cached, write, output, reasoning].every(Number.isFinite) || speed === undefined)
                return undefined;
            records.push({ provider, timestampMs: ts, model, ...(rateModel === undefined ? {} : { rateModel }),
                sessionId: (typeof si === "number" ? sessions[si] : undefined) ?? "",
                totals: { uncachedInputTokens: uncached, cachedInputTokens: cached, cacheCreationTokens: write, outputTokens: output, reasoningTokens: reasoning },
                reportedCostUsd: typeof cost === "number" ? cost : null, speed, dedupeKey: typeof key === "string" ? key : null });
        }
        return records;
    };
    for (const [path, entry] of Object.entries(document.files)) {
        if (!object(entry) || typeof entry.p !== "string" || !isTranscriptProvider(entry.p) ||
            typeof entry.s !== "number" || typeof entry.m !== "number" || !Array.isArray(entry.r) || !Array.isArray(entry.t))
            continue;
        const { o, gl, gh } = entry;
        if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0 ||
            typeof gl !== "number" || !Number.isSafeInteger(gl) || gl < 0 || gl > GUARD_LENGTH || gl > o ||
            typeof gh !== "number" || !Number.isFinite(gh))
            continue;
        const codec = transcriptFormats[entry.p].state;
        if (entry.cs !== null && (codec === undefined || codec.decode(entry.cs) === undefined))
            continue;
        const records = decodeRecords(entry.r, entry.p);
        const tailRecords = decodeRecords(entry.t, entry.p);
        if (!records || !tailRecords)
            continue;
        files.set(path, { provider: entry.p, size: entry.s, mtimeMs: entry.m, records, tailRecords,
            position: { resumeOffset: o, guardLength: gl, guardHash: gh, state: entry.cs } });
    }
    return { files, sources };
}
export function dedupeWithinFile(records, seen = new Set()) {
    return records.filter((record) => {
        if (record.dedupeKey === null)
            return true;
        if (seen.has(record.dedupeKey))
            return false;
        seen.add(record.dedupeKey);
        return true;
    });
}
/** T3's per-file stitching: retain committed records on resume, replace tails. */
export async function refreshTranscript(file, provider, cached) {
    if (cached?.provider === provider && cached.size === file.size && cached.mtimeMs === file.mtimeMs)
        return cached;
    const resume = cached?.provider === provider && file.size > cached.size ? cached.position : undefined;
    // The format/state types are paired by provider; the reader never mixes them.
    const format = transcriptFormats[provider];
    const parsed = await readTranscriptRecords(file.path, format, resume);
    if (parsed === null)
        return cached?.provider === provider ? cached : undefined;
    const base = parsed.resumed && cached ? cached.records : [];
    const seen = new Set();
    const records = dedupeWithinFile([...base, ...parsed.records], seen);
    const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);
    return { provider, size: file.size, mtimeMs: file.mtimeMs, records, tailRecords, position: parsed.position };
}
const DAY_MS = 86_400_000;
export const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
export const CACHE_RETENTION_DAYS = 92;
function isWithinDirectory(path, dir) {
    const rel = relative(dir, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Own read-only incremental state, separate from T3's on-disk scan cache. */
export class TranscriptReader {
    #cache = new Map();
    #seed;
    #pending = Promise.resolve([]);
    read(cache, sinceMs, now) {
        // A daemon refresh and an overlapping observer read share serialized state.
        const next = this.#pending.then(() => this.#read(cache, sinceMs, now));
        this.#pending = next.catch(() => []);
        return next;
    }
    async #read(cache, sinceMs, now) {
        const retention = now - CACHE_RETENTION_DAYS * DAY_MS;
        if (this.#seed !== cache) {
            for (const [path, entry] of cache.files) {
                const own = this.#cache.get(path);
                if (!own || entry.mtimeMs > own.mtimeMs || (entry.mtimeMs === own.mtimeMs && entry.size > own.size))
                    this.#cache.set(path, entry);
            }
            this.#seed = cache;
        }
        const scanSince = sinceMs - MTIME_SLACK_MS;
        const retainedSince = Math.max(scanSince, retention);
        const bySource = [];
        const sourceKeys = new Set();
        for (const source of cache.sources) {
            const dir = await fs.realpath(source.configuredDir || source.dir).catch(() => source.dir);
            const sourceKey = `${source.provider}\0${dir}`;
            if (sourceKeys.has(sourceKey))
                continue;
            sourceKeys.add(sourceKey);
            const { files } = await listTranscriptFiles(dir, scanSince, source.provider === "grok" ? { fileName: "updates.jsonl" } : undefined);
            // Reads run concurrently, but updates and aggregation retain readdir order.
            const updates = new Array(files.length);
            const queue = files.entries();
            await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
                for (const [index, file] of queue)
                    updates[index] = await refreshTranscript(file, source.provider, this.#cache.get(file.path));
            }));
            const live = new Set();
            const batch = [];
            for (const [index, file] of files.entries()) {
                live.add(file.path);
                const entry = updates[index];
                if (!entry)
                    continue;
                this.#cache.set(file.path, entry);
                batch.push({ path: file.path, records: [...entry.records, ...entry.tailRecords] });
            }
            // Deleted files and unavailable directories retain their cached history.
            for (const [path, entry] of this.#cache) {
                if (entry.provider === source.provider && entry.mtimeMs >= retainedSince && !live.has(path) && isWithinDirectory(path, dir)) {
                    batch.push({ path, records: [...entry.records, ...entry.tailRecords] });
                }
            }
            bySource.push(batch);
        }
        // Legacy callers without a source map still receive their cached records.
        if (cache.sources.length === 0)
            bySource.push([...this.#cache].map(([path, entry]) => ({ path, records: [...entry.records, ...entry.tailRecords] })));
        for (const [path, entry] of this.#cache)
            if (entry.mtimeMs < retention)
                this.#cache.delete(path);
        const files = bySource.flat();
        const firstFile = new Map();
        const shared = new Set();
        for (const [index, file] of files.entries())
            for (const record of file.records) {
                if (record.provider !== "codex" || !record.sessionId)
                    continue;
                const first = firstFile.get(record.sessionId);
                if (first === undefined)
                    firstFile.set(record.sessionId, index);
                else if (first !== index)
                    shared.add(record.sessionId);
            }
        const records = [];
        for (const file of files) {
            const occurrences = new Map();
            for (const record of file.records) {
                if (record.provider !== "codex" || !shared.has(record.sessionId)) {
                    records.push(record);
                    continue;
                }
                const key = JSON.stringify([record.provider, record.sessionId, record.timestampMs, record.model, record.totals]);
                const occurrence = (occurrences.get(key) ?? 0) + 1;
                occurrences.set(key, occurrence);
                records.push({ ...record, dedupeKey: `${key}:${occurrence}` });
            }
        }
        return records;
    }
}
