// The core loop (`deputy core`, kept alive by the guard of `deputy start`): run each job's cheap
// check on its own timer. When a check finds work, start one headless agent run with the job's
// prompt and wait for it.
//
// - A run that handled none of its items failed, whatever its exit code.
// - After a good run the job is checked again at once, so work that came in meanwhile isn't left
//   for a cycle. After a failed run the job waits longer each time (5, 10, 20, 40, then 60 minutes
//   with a 5-minute timer), so a broken run can't burn usage.
// - One run at a time, across all jobs. The lock names the run's process, so a run that died
//   (killed, crashed, PC restarted) never blocks the next one.
// - Between runs, when deputy's own code changed on disk, the loop returns so the guard starts the
//   new code.
// Nothing runs, and no model is paid, while the checks find nothing.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ROOT } from "./config.mjs";
import { loadJobs } from "./jobs.mjs";
import { isAlive } from "./status.mjs";
import { listHeld } from "./post.mjs";
import { readJson, sleep, spawnTool, writeJson } from "./util.mjs";

export function makeLog(file, who = "") {
  return (line) => {
    try { if (existsSync(file) && statSync(file).size > 2_000_000) renameSync(file, file + ".old"); } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${who}${line}\n`);
  };
}

/** The last few lines of the run's own summary, flattened for a pop-up. Pure. */
export function gist(text, lines = 4) {
  return String(text).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^\s*(#+|>|[-*])\s+/gm, "").replace(/[*`]/g, "")
    .split("\n").map((l) => l.trim()).filter(Boolean).slice(-lines).join(" · ");
}

/**
 * Is a run going? The lock holds the run's process id: a dead process means no, at once. A lock
 * older than the run limit means no as well, whatever it says.
 */
export function lockHeld(lockPath, limitMs, now = Date.now(), alive = isAlive) {
  if (!existsSync(lockPath)) return false;
  if (now - statSync(lockPath).mtimeMs >= limitMs) return false;
  try {
    const { pid } = JSON.parse(readFileSync(lockPath, "utf8"));
    return Boolean(pid) && alive(pid);
  } catch {
    return false;
  }
}

/** How long a job waits after `failed` failed runs in a row: its timer, doubling, at most an hour. Pure. */
export function backoffMs(everyMinutes, failed) {
  if (failed <= 0) return everyMinutes * 60_000;
  return Math.min(everyMinutes * 60_000 * 2 ** (failed - 1), 60 * 60_000);
}

/** Which job to check next, and how long to wait for it. Pure. */
export function nextDue(due, now = Date.now()) {
  let best = null;
  for (const [name, at] of Object.entries(due)) if (best === null || at < due[best]) best = name;
  return { job: best, waitMs: best === null ? 0 : Math.max(0, due[best] - now) };
}

/** Did the run handle at least one item? An item is handled when the check no longer returns it at that version. Pure. */
export function progressed(batch, after) {
  const key = (i) => `${i.id}@${i.version ?? ""}`;
  const still = new Set(after.map(key));
  return batch.some((i) => !still.has(key(i)));
}

/** The newest modification time among deputy's own code files: when it changes, the core reloads. */
export function codeStamp(root = ROOT) {
  let newest = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|md|ps1)$/.test(e.name)) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const d of ["bin", "src", "prompts"]) if (existsSync(join(root, d))) walk(join(root, d));
  return newest;
}

/**
 * The driver's arguments. Claude Code only reads and edits inside its folders, so a run started in
 * the state folder also gets the PR checkouts, deputy's own files, the docs and the team and voice
 * files' folders. Pure.
 */
export function driverArgs(config, driver = config.driver) {
  const args = [...driver.args];
  const name = String(driver.command).split(/[\\/]/).pop().toLowerCase();
  if (!name.startsWith("claude") || args.includes("--add-dir")) return args;
  const files = [config.context.teamFile, config.context.voiceFile, config.context.checklist, config.context.reviewerRules].filter(Boolean).map((f) => dirname(f));
  const dirs = [config.checkouts.root, ROOT, config.context.docsDir, ...files].filter(Boolean);
  const inside = (d, root) => { const a = resolve(d).toLowerCase(), b = resolve(root).toLowerCase(); return a === b || a.startsWith(b + sep); };
  for (const dir of dirs.filter((d, i) => !dirs.slice(0, i).some((e) => inside(d, e)))) args.push("--add-dir", dir);
  return args;
}

/** Start the driver (Claude Code by default) with the job's prompt on stdin. */
export function startAgentRun({ config, paths, job, items, log, onStart = () => {} }) {
  return new Promise((resolve) => {
    mkdirSync(paths.runs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runLog = join(paths.runs, `run-${stamp}-${job.name}.log`);
    const prompt = job.prompt(items);
    writeFileSync(join(paths.runs, `run-${stamp}-${job.name}.prompt.md`), prompt);
    log(`${job.name}: run started for ${items.map(job.label).join(", ")} -> ${runLog}`);
    const driver = job.driver ?? config.driver;
    mkdirSync(config.checkouts.root, { recursive: true });
    const child = spawnTool(driver.command, driverArgs(config, driver), { cwd: paths.state, env: { ...process.env, DEPUTY_RUN: stamp, DEPUTY_JOB: job.name } });
    onStart(child.pid);
    child.stdin.end(prompt);
    let out = "";
    child.stdout.on("data", (d) => { out += d; appendFileSync(runLog, d); });
    child.stderr.on("data", (d) => appendFileSync(runLog, d));
    child.on("error", (e) => appendFileSync(runLog, `\n${e}\n`));
    const timer = setTimeout(() => { log(`${job.name}: run passed ${config.runLimitMinutes} minutes, stopping it`); child.kill(); }, config.runLimitMinutes * 60_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, log: runLog }); });
  });
}

/**
 * The watcher loop. Every side effect is a parameter, so the demo and tests drive the same code.
 * `once` checks every job one time. Otherwise it returns when `shouldStop()` is true, or with
 * `reload: true` when `codeChanged()` says deputy's code changed (checked between runs).
 */
export async function watch({ config, paths, gh, notify, jobs = loadJobs(config), runAgent = startAgentRun, wait = sleep, shouldStop = () => false, codeChanged = () => false, once = false, now = Date.now }) {
  mkdirSync(paths.state, { recursive: true });
  const log = makeLog(paths.log);
  const prev = readJson(paths.status, {});
  let status = {
    pid: process.pid, startedAt: new Date().toISOString(), posting: jobs.some((j) => j.builtin === "pr-review") ? config.posting : null, state: "idle", running: null,
    lastRun: prev?.lastRun ?? null, checkedAt: null, lastError: null, failuresInARow: 0, paused: null,
    jobs: Object.fromEntries(jobs.map((j) => [j.name, { everyMinutes: j.everyMinutes, checkedAt: null, lastError: null, failuresInARow: 0, lastFound: 0, failedRuns: 0, retryAt: null }])),
  };
  const save = (patch) => { status = { ...status, ...patch }; writeJson(paths.status, status); };
  const saveJob = (name, patch) => save({ jobs: { ...status.jobs, [name]: { ...status.jobs[name], ...patch } } });
  save({});
  log(`core started (pid ${process.pid}): ${jobs.map((j) => `${j.name} every ${j.everyMinutes} min`).join(", ")}; posting: ${config.posting}`);

  const due = Object.fromEntries(jobs.map((j) => [j.name, now()]));
  const queue = once ? jobs.map((j) => j.name) : null;
  while (!shouldStop()) {
    if (!once && codeChanged()) { log("new code found, reloading"); save({ state: "reloading" }); return { ...status, reload: true }; }
    let name;
    if (queue) {
      if (!queue.length) break;
      name = queue.shift();
    } else {
      const next = nextDue(due, now());
      if (next.job === null) break;
      if (next.waitMs > 0) { await wait(next.waitMs); if (shouldStop()) break; continue; }
      name = next.job;
    }
    const job = jobs.find((j) => j.name === name);
    due[name] = now() + job.everyMinutes * 60_000;
    try {
      if (lockHeld(paths.lock, config.runLimitMinutes * 60_000)) continue;
      const found = await job.check({ gh, done: readJson(paths.done, {}), paths, config });
      const at = new Date().toISOString();
      saveJob(name, { checkedAt: at, lastError: null, failuresInARow: 0, lastFound: found.length });
      save({ checkedAt: at, lastError: null, failuresInARow: 0 });
      const batch = found.slice(0, job.maxItemsPerRun);
      if (!batch.length) continue;

      // `deputy pause` stops new runs; the checks go on, so status still says what waits.
      const pause = readJson(paths.pause, null);
      if (pause) { save({ state: "paused", paused: { ...pause, waiting: found.length } }); continue; }
      if (status.paused) save({ state: "idle", paused: null });

      const items = batch.map((i) => ({ id: i.id, label: job.label(i), ...(i.repo ? { repo: i.repo, number: i.number } : {}) }));
      const heldBefore = listHeld(paths.held).map((h) => h.name);
      writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
      save({ state: "running", running: { job: name, items } });
      const r = await runAgent({ config, paths, job, items: batch, log, onStart: (pid) => pid && writeFileSync(paths.lock, JSON.stringify({ pid, at: Date.now() })) })
        .finally(() => rmSync(paths.lock, { force: true }));
      log(`${name}: run finished with code ${r.code}`);
      if (job.afterRun) await job.afterRun({ items: batch }).catch((e) => log(`${name}: after-run step failed: ${e.message ?? e}`));

      let moved = r.code === 0;
      if (r.code === 0) {
        try { moved = progressed(batch, await job.check({ gh, done: readJson(paths.done, {}), paths, config })); } catch {}
        if (!moved) log(`${name}: the run handled none of its items, counting it as failed`);
      }
      const failedRuns = moved ? 0 : (status.jobs[name]?.failedRuns ?? 0) + 1;
      const retryMs = backoffMs(job.everyMinutes, failedRuns);
      saveJob(name, { failedRuns, retryAt: moved ? null : new Date(now() + retryMs).toISOString() });
      save({ state: "idle", running: null, lastRun: { job: name, at: new Date().toISOString(), items, code: r.code, handled: moved, log: r.log } });

      const label = items.map((i) => i.label).join(", ");
      notify(moved ? `${job.doneVerb ?? "Done"}: ${label}` : `${name} run failed${r.code ? ` (exit ${r.code})` : ", nothing handled"}`, gist(r.out) || r.log);
      const fresh = listHeld(paths.held).filter((h) => !heldBefore.includes(h.name));
      if (fresh.length) notify(`${fresh.length} review${fresh.length > 1 ? "s" : ""} held for you`, `${fresh.map((h) => `${h.repo} #${h.number}`).join(", ")}. Run: deputy held`);
      if (failedRuns === 2) notify(`deputy: ${name} runs keep failing`, `Two runs in a row failed. It keeps retrying, waiting longer each time. Log: ${r.log}`);
      if (failedRuns) log(`${name}: ${failedRuns} failed run(s) in a row, next try in ${retryMs / 60_000} minutes`);
      if (!queue) due[name] = moved ? now() : now() + retryMs;
    } catch (error) {
      const line = String(error.message ?? error).split("\n")[0];
      log(`${name}: check failed: ${line}`);
      const failures = (status.jobs[name]?.failuresInARow ?? 0) + 1;
      saveJob(name, { checkedAt: new Date().toISOString(), lastError: line, failuresInARow: failures });
      save({ lastError: `${name}: ${line}`, failuresInARow: status.failuresInARow + 1 });
      if (failures === 3) notify(`deputy: the ${name} check keeps failing`, line);
    }
  }
  return status;
}

/** One process per pid file: a live process holding it means this copy leaves. */
export function claimPidFile(pidPath) {
  if (existsSync(pidPath)) {
    const old = Number(readFileSync(pidPath, "utf8"));
    if (old && old !== process.pid && isAlive(old)) return old;
  }
  writeFileSync(pidPath, String(process.pid));
  return null;
}
