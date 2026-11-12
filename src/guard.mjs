// The guard (`deputy start`): keeps the core (`deputy core`) alive.
//   - The core exits 0 to reload new code: start it again at once.
//   - The core crashes: start it again after 30 seconds, waiting longer each time it keeps crashing
//     (60 s, 2 min, 4 min, then 5 min). A core that ran fine for 10 minutes starts the count again.
import { spawn } from "node:child_process";

/** How long to wait before starting the core again after `crashes` crashes in a row. Pure. */
export function restartDelayMs(crashes) {
  if (crashes <= 0) return 0;
  return Math.min(30_000 * 2 ** (crashes - 1), 5 * 60_000);
}

/**
 * Supervise the core. `startCore()` returns something with `on("exit", (code) => ...)`.
 * Returns `stop()`. Every side effect is a parameter, so tests can drive it.
 */
export function supervise({ startCore, log = () => {}, later = setTimeout, now = Date.now, healthyAfterMs = 10 * 60_000 }) {
  let crashes = 0, stopped = false, current = null;
  const start = () => {
    if (stopped) return;
    const startedAt = now();
    current = startCore();
    current.on("exit", (code) => {
      if (stopped) return;
      if (code === 0) { crashes = 0; log("core reloading"); start(); return; }
      if (now() - startedAt > healthyAfterMs) crashes = 0;
      crashes += 1;
      const wait = restartDelayMs(crashes);
      log(`core stopped (code ${code}), starting it again in ${wait / 1000} s`);
      later(start, wait);
    });
  };
  start();
  return () => { stopped = true; try { current?.kill?.(); } catch {} };
}

/** Start the core as its own Node process, with the same config. */
export function spawnCore(bin, configFile) {
  const args = [bin, "core", ...(configFile ? ["--config", configFile] : [])];
  return spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
}
