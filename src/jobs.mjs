// A job is a cheap check plus a prompt.
//
// The check runs on a timer and costs nothing: it asks GitHub, a CI system, a queue, anything, and
// returns the items that need work right now. Only when it returns something does deputy start a
// headless agent run, with the job's prompt and those items. Each item has an `id` and a `version`;
// once a run records an item at a version (`deputy record`), it isn't picked up again until its
// version changes (a PR's new head, a CI run's new attempt, an issue's new update time).
//
// Built in: "pr-review". Your own: any command that prints a JSON list of items, and a prompt file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEPUTY_BIN, ROOT, validate } from "./config.mjs";
import { findPending } from "./pending.mjs";
import { buildPrompt, renderTemplate } from "./prompt.mjs";
import { run } from "./util.mjs";

export const doneKey = (job, id) => `${job}:${id}`;

export function doneVersion(entry) {
  return typeof entry === "string" ? entry : entry?.version ?? entry?.head ?? null;
}

/**
 * The items a check returned that still need work: valid, not seen twice, and not already handled
 * at this version. Pure.
 */
export function selectFresh(jobName, items, done = {}) {
  if (!Array.isArray(items)) throw new Error(`job ${jobName}: the check must print a JSON list, got ${typeof items}`);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || (typeof item.id !== "string" && typeof item.id !== "number")) throw new Error(`job ${jobName}: every item needs an "id"`);
    const id = String(item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const version = item.version == null ? null : String(item.version);
    const handled = doneVersion(done[doneKey(jobName, id)]);
    if (handled !== null && handled === (version ?? handled)) continue;
    out.push({ ...item, id, version });
  }
  return out;
}

function q(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}

export function deputyCommand(config) {
  return `node ${q(DEPUTY_BIN.replace(/\\/g, "/"))}${config.file ? ` --config ${q(config.file.replace(/\\/g, "/"))}` : ""}`;
}

/** A file path in a job definition: relative to the config file first, then to deputy's own folder. */
export function resolveJobPath(config, p) {
  if (!p || isAbsolute(p)) return p;
  const base = config.file ? dirname(config.file) : process.cwd();
  const local = resolve(base, p);
  return existsSync(local) ? local : existsSync(resolve(ROOT, p)) ? resolve(ROOT, p) : local;
}

/** The built-in job: pull requests that wait on your review. */
function prReviewJob(def, config) {
  return {
    name: def.name,
    builtin: "pr-review",
    everyMinutes: def.everyMinutes ?? config.pollMinutes,
    maxItemsPerRun: def.maxItemsPerRun ?? config.maxPrsPerRun,
    driver: def.driver ?? config.driver,
    async check({ gh, done }) {
      const prs = await findPending({ config, gh, done, job: def.name });
      return prs.map((p) => ({ ...p, id: `${p.repo}#${p.number}`, version: p.head }));
    },
    prompt: (items) => buildPrompt(config, items, def.name),
    label: (item) => `${item.repo.split("/")[1]} #${item.number}`,
    doneVerb: "Reviewed",
  };
}

/** Your own job: `check` is a command (a list: program, then arguments) that prints JSON items. */
function commandJob(def, config) {
  const [program, ...args] = def.check;
  const argv = args.map((a) => (/\.(m?js|cjs|sh|ps1|py)$/.test(a) ? resolveJobPath(config, a) : a));
  const promptFile = resolveJobPath(config, def.prompt);
  return {
    name: def.name,
    everyMinutes: def.everyMinutes ?? config.pollMinutes,
    maxItemsPerRun: def.maxItemsPerRun ?? 4,
    driver: def.driver ?? config.driver,
    async check({ done, paths }) {
      const r = await run(program, argv, {
        timeoutMs: (def.checkTimeoutSeconds ?? 120) * 1000,
        cwd: config.file ? dirname(config.file) : process.cwd(),
        env: { ...process.env, DEPUTY_JOB: def.name, DEPUTY_STATE: paths.state, DEPUTY_DONE: paths.done, ...(def.env ?? {}) },
      });
      if (r.code !== 0) throw new Error(`job ${def.name}: check exited ${r.timedOut ? "(timed out)" : r.code}: ${(r.stderr || r.stdout).trim().split("\n").pop() ?? ""}`);
      let items;
      try { items = JSON.parse(r.stdout.trim() || "[]"); } catch { throw new Error(`job ${def.name}: the check's output is not JSON`); }
      return selectFresh(def.name, items, done);
    },
    prompt: (items) => renderTemplate(readFileSync(promptFile, "utf8"), {
      JOB: def.name, ITEMS_JSON: JSON.stringify(items, null, 2), DEPUTY: deputyCommand(config),
      LOGIN: config.github?.login ?? "", STATE: config.stateDir, ...(def.vars ?? {}),
    }),
    label: (item) => item.title ? `${item.title}`.slice(0, 60) : item.id,
    doneVerb: def.doneVerb ?? "Done",
  };
}

/** Problems with the job list, for `validate`. */
export function jobProblems(config) {
  const problems = [];
  const jobs = config.jobs ?? [];
  if (!jobs.length) problems.push("jobs is empty: nothing to watch");
  const names = new Set();
  for (const j of jobs) {
    if (!j.name || !/^[\w.-]+$/.test(j.name)) problems.push(`a job needs a name of letters, digits, - or _ (got "${j.name}")`);
    if (names.has(j.name)) problems.push(`two jobs are named "${j.name}"`);
    names.add(j.name);
    if (j.everyMinutes != null && !(j.everyMinutes >= 1)) problems.push(`job ${j.name}: everyMinutes must be at least 1`);
    if (j.builtin) {
      if (j.builtin !== "pr-review") problems.push(`job ${j.name}: unknown builtin "${j.builtin}" (built in: pr-review)`);
      continue;
    }
    if (!Array.isArray(j.check) || !j.check.length) problems.push(`job ${j.name}: "check" must be a command list, like ["node", "check.mjs"]`);
    if (!j.prompt) problems.push(`job ${j.name}: "prompt" must name a prompt file`);
    else if (!existsSync(resolveJobPath(config, j.prompt))) problems.push(`job ${j.name}: prompt file ${j.prompt} not found`);
  }
  return problems;
}

export function loadJobs(config) {
  return (config.jobs ?? []).filter((j) => j.enabled !== false).map((j) => (j.builtin ? prReviewJob(j, config) : commandJob(j, config)));
}

export function usesPrReview(config) {
  return (config.jobs ?? []).some((j) => j.builtin === "pr-review" && j.enabled !== false);
}


/** Every problem with the config, jobs included. */
export function checkConfig(config) {
  return validate(config, { jobProblems, usesPrReview });
}
