#!/usr/bin/env node
// Prefer the compiled build (works from node_modules); fall back to the
// TypeScript sources when running from a checkout (Node >= 22.18 strips types).
import { existsSync } from "node:fs";

const dist = new URL("../dist/cli.js", import.meta.url);
await import(existsSync(dist) ? dist.href : new URL("../src/cli.ts", import.meta.url).href);
