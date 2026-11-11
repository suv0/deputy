// `deputy start`: run each job's cheap check on its own timer. When a check finds work, start one
// headless agent run with the job's prompt, wait for it, then check that job again straight away (work
// that came in meanwhile is picked up now, not a cycle later). After a failed run the job waits its
// usual time, so a broken run can't repeat in a tight loop. One run at a time, across all jobs.
// Nothing runs, and no model is paid, while the checks find nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { loadJobs } from "./jobs.mjs";
import { isAlive } from "./status.mjs";
import { listHeld } from "./post.mjs";
import { readJson, sleep, spawnTool, writeJson } from "./util.mjs";

export function makeLog(file) {
  return (line) => {
    try { if (existsSync(file) && statSync(file).size > 2_000_000) renameSync(file, file + ".old"); } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  };
}

/** The last few lines of the run's own summary, flattened for a pop-up. Pure. */
export function gist(text, lines = 4) {
  return String(text).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^\s*(#+|>|[-*])\s+/gm, "").replace(/[*`]/g, "")
    .split("\n").map((l) => l.trim()).filter(Boolean).slice(-lines).join(" · ");
}

/** A lock younger than the run limit means a run is going; an older one is from a run that died. */
export function lockHeld(lockPath, limitMs, now = Date.now()) {
  return existsSync(lockPath) && now - statSync(lockPath).mtimeMs < limitMs;
}

/** Which job to check next, and how long to wait for it. Pure. */
export function nextDue(due, now = Date.now()) {
  let best = null;
  for (const [name, at] of Object.entries(due)) if (best === null || at < due[best]) best = name;
  return { job: best, waitMs: best === null ? 0 : Math.max(0, due[best] - now) };
}

/**
 * The driver's arguments. Claude Code only reads and edits inside its folders, so a run started in
 * the state folder also gets the PR checkouts, deputy's own files and the docs. Pure.
 */
export function driverArgs(config, driver = config.driver) {
  const args = [...driver.args];
  const name = String(driver.command).split(/[\/]/).pop().toLowerCase();
  if (!name.startsWith("claude") || args.includes("--add-dir")) return args;
  for (const dir of [config.checkouts.root, ROOT, config.context.docsDir].filter(Boolean)) args.push("--add-dir", dir);
  return args;
}

/** Start the driver (Claude Code by default) with the job's prompt on stdin. */
export function startAgentRun({ config, paths, job, items, log }) {
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
 * `once` checks every job one time. Otherwise it returns when `shouldStop()` is true.
 */
export async function watch({ config, paths, gh, notify, jobs = loadJobs(config), runAgent = startAgentRun, wait = sleep, shouldStop = () => false, once = false, now = Date.now }) {
  mkdirSync(paths.state, { recursive: true });
  const log = makeLog(paths.log);
  let status = {
    pid: process.pid, startedAt: new Date().toISOString(), posting: config.posting, state: "idle", running: null, lastRun: null,
    checkedAt: null, lastError: null, failuresInARow: 0,
    jobs: Object.fromEntries(jobs.map((j) => [j.name, { everyMinutes: j.everyMinutes, checkedAt: null, lastError: null, failuresInARow: 0, lastFound: 0 }])),
  };
  const save = (patch) => { status = { ...status, ...patch }; writeJson(paths.status, status); };
  const saveJob = (name, patch) => save({ jobs: { ...status.jobs, [name]: { ...status.jobs[name], ...patch } } });
  save({});
  log(`watching: ${jobs.map((j) => `${j.name} every ${j.everyMinutes} min`).join(", ")}; posting: ${config.posting}`);

  const due = Object.fromEntries(jobs.map((j) => [j.name, now()]));
  const queue = once ? jobs.map((j) => j.name) : null;
  while (!shouldStop()) {
    let name;
    if (queue) {
      if (!queue.length) break;
      name = queue.shift();
    } else {
      const next = nextDue(due, now());
      if (next.job === null) break;
      if (next.waitMs > 0) { await wait(next.waitMs); if (shouldStop()) break; }
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

      const items = batch.map((i) => ({ id: i.id, label: job.label(i), ...(i.repo ? { repo: i.repo, number: i.number } : {}) }));
      const heldBefore = listHeld(paths.held).map((h) => h.name);
      writeFileSync(paths.lock, String(Date.now()));
      save({ state: "running", running: { job: name, items } });
      const r = await runAgent({ config, paths, job, items: batch, log }).finally(() => rmSync(paths.lock, { force: true }));
      log(`${name}: run finished with code ${r.code}`);
      save({ state: "idle", running: null, lastRun: { job: name, at: new Date().toISOString(), items, code: r.code, log: r.log } });
      const label = items.map((i) => i.label).join(", ");
      notify(r.code === 0 ? `${job.doneVerb ?? "Done"}: ${label}` : `${name} run failed (exit ${r.code})`, gist(r.out) || r.log);
      const fresh = listHeld(paths.held).filter((h) => !heldBefore.includes(h.name));
      if (fresh.length) notify(`${fresh.length} review${fresh.length > 1 ? "s" : ""} held for you`, `${fresh.map((h) => `${h.repo} #${h.number}`).join(", ")}. Run: deputy held`);
      // A good run checks the same job again at once; a failed one waits its usual time.
      if (r.code === 0 && !queue) due[name] = now();
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

/** One watcher at a time: a live process holding the pid file means this copy leaves. */
export function claimPidFile(pidPath) {
  if (existsSync(pidPath)) {
    const old = Number(readFileSync(pidPath, "utf8"));
    if (old && old !== process.pid && isAlive(old)) return old;
  }
  writeFileSync(pidPath, String(process.pid));
  return null;
}
