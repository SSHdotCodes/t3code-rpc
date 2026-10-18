import { homedir } from "node:os";
import { join, resolve } from "node:path";
export function resolveT3Paths(opts = {}) {
    // Upstream's server/desktop use T3CODE_HOME. T3_HOME is not an upstream override.
    const home = resolve(opts.home?.trim() || (opts.env ?? process.env).T3CODE_HOME?.trim() || join(homedir(), ".t3"));
    const userdataDir = join(home, "userdata");
    return {
        home,
        userdataDir,
        dbPath: join(userdataDir, "statev2.sqlite"),
        runtimePath: join(userdataDir, "server-runtime.json"),
        settingsPath: join(userdataDir, "settings.json"),
    };
}
