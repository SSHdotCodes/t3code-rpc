import { performance } from "node:perf_hooks";
import { detectApp } from "../src/t3/detect.ts";
import { T3Database } from "../src/t3/db.ts";
import { StateReader } from "../src/t3/state.ts";
import { readUsage } from "../src/t3/usage.ts";

const totalStart = performance.now();
const detectStart = performance.now();
const app = await detectApp();
const detectMs = performance.now() - detectStart;
const db = new T3Database(app.dbPath ?? undefined);
try {
  const reader = new StateReader(db);
  const stateStart = performance.now();
  const state = reader.read();
  const stateMs = performance.now() - stateStart;
  const usageStart = performance.now();
  const usage = readUsage(db, { windowDays: 30 });
  const usageMs = performance.now() - usageStart;
  // IDs can embed upstream task references. They remain internal to the reader
  // and are omitted from diagnostic output as well as from Rich Presence.
  const publicState = { ...state, threads: state.threads.map(({ threadId: _id, children, ...thread }) => ({
    ...thread, children: children.map(({ key: _key, ...child }) => child),
  })) };
  console.log(JSON.stringify({ app, state: publicState, usage, timingsMs: {
    detect: +detectMs.toFixed(3), state: +stateMs.toFixed(3), usage: +usageMs.toFixed(3), total: +(performance.now() - totalStart).toFixed(3),
  } }, null, 2));
} finally {
  db.close();
}
