// Streaming JSON projection for oversized transcript lines. Unselected string
// values are validated and discarded a chunk at a time, never assembled.
import type { SelectedFields } from "./transcripts.ts";

type Selection = true | SelectedFields | false;
type Phase = "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
interface Frame {
  array: boolean;
  phase: Phase;
  selection: Selection;
  value: Record<string, unknown> | unknown[];
  key: string;
  index: number;
}

export function createUsageJsonReader(fields: SelectedFields) {
  const stack: Frame[] = [];
  let root: unknown;
  let complete = false;
  let malformed = false;
  let mode: "string" | "number" | "literal" | undefined;
  let token = "";
  let expected = "";
  let keyToken = false;
  let capture = false;
  let escape = false;
  let unicode = 0;
  let selection: Selection = false;
  const stringSpecial = /["\\\x00-\x1f]/g;
  const numberEnd = /[^0-9eE+.\-]/g;

  const nextSelection = (): Selection => {
    const parent = stack.at(-1);
    if (!parent) return fields;
    if (parent.selection === false || parent.selection === true) return parent.selection;
    return !parent.array && Object.hasOwn(parent.selection, parent.key) ? parent.selection[parent.key]! : false;
  };
  const accept = (value: unknown, selected: Selection) => {
    const parent = stack.at(-1);
    if (!parent) {
      if (complete) throw new Error("Repeated JSON value");
      root = value;
      complete = true;
      return;
    }
    if (parent.phase !== "value" && parent.phase !== "valueOrEnd") throw new Error("Unexpected JSON value");
    if (selected !== false) {
      // defineProperty preserves JSON.parse's own-property semantics for __proto__.
      Object.defineProperty(parent.value, parent.array ? parent.index : parent.key, {
        value, enumerable: true, writable: true, configurable: true,
      });
    }
    if (parent.array) parent.index++;
    parent.phase = "commaOrEnd";
  };
  const finishNumber = () => {
    const value: unknown = JSON.parse(token);
    if (typeof value !== "number") throw new Error("Invalid JSON number");
    accept(value, selection);
    token = "";
    mode = undefined;
  };
  const consume = (chunk: string) => {
    if (malformed) return;
    try {
      let i = 0;
      while (i < chunk.length) {
        if (mode === "string") {
          if (unicode > 0) {
            const char = chunk[i++]!;
            if (!/[0-9a-fA-F]/.test(char)) throw new Error("Invalid JSON unicode escape");
            if (capture) token += char;
            unicode--;
          } else if (escape) {
            const char = chunk[i++]!;
            if (!'"\\/bfnrtu'.includes(char)) throw new Error("Invalid JSON escape");
            if (capture) token += char;
            if (char === "u") unicode = 4;
            escape = false;
          } else {
            stringSpecial.lastIndex = i;
            const match = stringSpecial.exec(chunk);
            const end = match?.index ?? chunk.length;
            if (capture) token += chunk.slice(i, end);
            i = end;
            if (!match) continue;
            const char = chunk[i++]!;
            if (char === "\\") {
              if (capture) token += char;
              escape = true;
            } else if (char === '"') {
              const value: unknown = capture ? JSON.parse('"' + token + '"') : undefined;
              if (keyToken) {
                const parent = stack.at(-1)!;
                parent.key = capture ? value as string : "";
                parent.phase = "colon";
              } else accept(value, selection);
              mode = undefined;
              token = "";
            } else throw new Error("Control character in JSON string");
          }
          continue;
        }
        if (mode === "number") {
          numberEnd.lastIndex = i;
          const end = numberEnd.exec(chunk)?.index ?? chunk.length;
          token += chunk.slice(i, end);
          i = end;
          if (end < chunk.length) finishNumber();
          continue;
        }
        if (mode === "literal") {
          const char = chunk[i++]!;
          if (char !== expected[token.length]) throw new Error("Invalid JSON literal");
          token += char;
          if (token.length === expected.length) {
            accept(expected === "true" ? true : expected === "false" ? false : null, selection);
            mode = undefined;
            token = "";
          }
          continue;
        }
        const char = chunk[i++]!;
        if (char === " " || char === "\t" || char === "\r" || char === "\n") continue;
        const parent = stack.at(-1);
        if (char === "}" || char === "]") {
          if (!parent || parent.array !== (char === "]") ||
              !(parent.phase === "commaOrEnd" || parent.phase === (parent.array ? "valueOrEnd" : "keyOrEnd"))) {
            throw new Error("Unexpected JSON closing delimiter");
          }
          stack.pop();
          continue;
        }
        if (char === ":") {
          if (!parent || parent.phase !== "colon") throw new Error("Unexpected JSON colon");
          parent.phase = "value";
          continue;
        }
        if (char === ",") {
          if (!parent || parent.phase !== "commaOrEnd") throw new Error("Unexpected JSON comma");
          parent.phase = parent.array ? "value" : "key";
          continue;
        }
        keyToken = parent?.phase === "keyOrEnd" || parent?.phase === "key";
        if (keyToken) {
          if (char !== '"') throw new Error("Expected JSON key");
          capture = parent!.selection !== false;
          token = "";
          mode = "string";
          continue;
        }
        if ((parent && parent.phase !== "value" && parent.phase !== "valueOrEnd") || (!parent && complete)) {
          throw new Error("Unexpected JSON value");
        }
        selection = nextSelection();
        if (char === "{" || char === "[") {
          const array = char === "[";
          const value = array ? [] : {};
          accept(value, selection);
          stack.push({ array, phase: array ? "valueOrEnd" : "keyOrEnd", selection, value, key: "", index: 0 });
        } else if (char === '"') {
          mode = "string";
          capture = selection !== false;
          token = "";
        } else if (char === "-" || (char >= "0" && char <= "9")) {
          mode = "number";
          token = char;
        } else if (char === "t" || char === "f" || char === "n") {
          mode = "literal";
          expected = char === "t" ? "true" : char === "f" ? "false" : "null";
          token = char;
        } else throw new Error("Invalid JSON character");
      }
    } catch {
      malformed = true;
    }
  };
  return {
    write: consume,
    finish: (): unknown => {
      if (!malformed && mode === "number") {
        try { finishNumber(); } catch { malformed = true; }
      }
      return !malformed && mode === undefined && complete && stack.length === 0 ? root : undefined;
    },
  };
}
