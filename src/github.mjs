// A thin wrapper over the GitHub CLI. Everything that talks to GitHub takes one of these as a
// parameter, so tests and the demo can pass a fake instead.
import { run } from "./util.mjs";

export function makeGh({ command = "gh", timeoutMs = 120_000 } = {}) {
  const call = async (args, input) => {
    const r = await run(command, args, { input, timeoutMs });
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || `exit ${r.code}`;
      throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${r.timedOut ? "timed out" : why}`);
    }
    return r.stdout;
  };
  return {
    text: call,
    json: async (args, input) => JSON.parse(await call(args, input)),
  };
}
