import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveT3Paths } from "./paths.js";
// Intercept only the warning emitted while loading node:sqlite, leaving every
// other experimental/deprecation warning and the process's listeners intact.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
    const message = typeof warning === "string" ? warning : warning.message;
    const type = typeof warning === "string"
        ? (typeof args[0] === "object" && args[0] !== null ? args[0].type : args[0])
        : warning.name;
    if (type === "ExperimentalWarning" && /^SQLite is an experimental feature\b/.test(message))
        return;
    Reflect.apply(emitWarning, process, [warning, ...args]);
};
let sqlite;
try {
    sqlite = await import("node:sqlite");
}
finally {
    process.emitWarning = emitWarning;
}
const requiredTables = ["runs", "turn_items", "subagents", "provider_turns"].map((name) => `orchestration_v2_projection_${name}`);
export function isBusy(error) {
    const e = error;
    return e?.errcode === 5 || e?.errcode === 6 || /SQLITE_(BUSY|LOCKED)/.test(e?.code ?? "")
        || /database (?:is )?(?:locked|busy)/i.test(e?.message ?? "");
}
export class T3Database {
    path;
    settingsPath;
    #connection = null;
    #identity = "";
    #tables = new Set();
    #statements = new Map();
    #generation = 0;
    #transactionDepth = 0;
    constructor(path = resolveT3Paths().dbPath) {
        this.path = path;
        this.settingsPath = join(dirname(path), "settings.json");
    }
    get hasV2() {
        try {
            const connection = this.#open();
            // The daemon can start before the server finishes its first migration.
            // Refresh missing features instead of retaining an empty schema forever.
            if (!requiredTables.every((table) => this.#tables.has(table))) {
                this.#tables = new Set(connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
            }
            return requiredTables.every((table) => this.#tables.has(table));
        }
        catch {
            return false;
        }
    }
    /** Changes on reopen, so consumers can discard caches after DB replacement. */
    get generation() { this.#open(); return this.#generation; }
    #open() {
        // Skip repeated stat calls inside a short read transaction.
        if (this.#connection && this.#transactionDepth > 0)
            return this.#connection;
        try {
            const info = statSync(this.path);
            const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
            if (this.#connection && identity === this.#identity)
                return this.#connection;
            this.close();
            const connection = new sqlite.DatabaseSync(this.path, { readOnly: true });
            this.#connection = connection;
            connection.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250;");
            this.#tables = new Set(connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
            this.#identity = identity;
            this.#generation++;
            return connection;
        }
        catch (error) {
            this.close();
            throw error;
        }
    }
    all(sql, ...params) {
        try {
            const connection = this.#open();
            let statement = this.#statements.get(sql);
            if (!statement) {
                statement = connection.prepare(sql);
                this.#statements.set(sql, statement);
            }
            return statement.all(...params);
        }
        catch (error) {
            if (!isBusy(error))
                this.close();
            throw error;
        }
    }
    get(sql, ...params) {
        return this.all(sql, ...params)[0];
    }
    transaction(read) {
        const connection = this.#open();
        if (this.#transactionDepth)
            return read();
        connection.exec("BEGIN");
        this.#transactionDepth++;
        try {
            const result = read();
            connection.exec("COMMIT");
            return result;
        }
        catch (error) {
            try {
                connection.exec("ROLLBACK");
            }
            catch { /* Already closed after an I/O error. */ }
            throw error;
        }
        finally {
            this.#transactionDepth--;
        }
    }
    close() {
        this.#statements.clear();
        this.#tables.clear();
        this.#identity = "";
        try {
            this.#connection?.close();
        }
        catch { /* Closing an invalidated DB is best effort. */ }
        this.#connection = null;
    }
}
export { T3Database as StateDatabase };
