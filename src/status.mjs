// `deputy status [--line]`: is the watcher alive, and what is it doing? `--line` fits a status bar.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ago } from "./util.mjs";

/** Where one PR's review has got to, read from the files its run folder holds so far. */
export function stageOf(files, n) {
  const has = (f) => files.includes(f);
  if (has(`send-${n}.json`)) return "posted";
  if (has(`held-${n}`)) return "held for you";
  if (has(`review-${n}.json`)) return "checking the draft, about to post";
  if (has("challenge.md")) return "challenge done, checking claims in the code";
  if (has("challenge-brief.md")) return "challenge model is trying to disprove the draft";
  if (has("answer.md")) return "review drafted, checking claims in the code";
  if (has("brief.md")) return "review model is reviewing";
  if (has("facts.md")) return "facts gathered";
  if (has("facts-brief.md")) return "gathering facts";
  return "setting up";
}

export function runDirName(repo, number) {
  return `${repo.replace("/", "-")}-${number}`;
}

/** Jobs whose last check is more than two cycles old (and five minutes) while nothing runs. Pure. */
export function stuckJobs(s, now = Date.now()) {
  if (s.state === "running") return [];
  return Object.entries(s.jobs ?? {}).filter(([name, j]) => {
    // A long run of this job is not a stuck check: count from whichever came last.
    const runAt = s.lastRun?.job === name ? s.lastRun.at : null;
    const since = [j.checkedAt ?? s.startedAt, runAt].filter(Boolean).sort().at(-1);
    return since && now - Date.parse(since) > (j.everyMinutes * 2 + 5) * 60_000;
  }).map(([name, j]) => ({ name, checkedAt: j.checkedAt }));
}

/**
 * The one-line health summary, for a terminal or a status bar.
 * @param s       status.json contents, or null
 * @param alive   whether s.pid is a live process
 * @param held    how many reviews wait in held/
 */
export function describeStatus(s, { now = Date.now(), alive = false, held = 0 } = {}) {
  let line;
  const failing = Object.entries(s?.jobs ?? {}).filter(([, j]) => j.lastError).map(([n]) => n);
  if (!s) line = "deputy: not started yet (deputy start)";
  else if (!alive || s.state === "stopped") line = `deputy: STOPPED (last check ${ago(s.checkedAt, now)})`;
  else if (s.state === "running" && s.running) line = `deputy: ${s.running.job} running for ${s.running.items.map((i) => i.label).join(", ")}`;
  else if (stuckJobs(s, now).length) line = `deputy: STUCK (${stuckJobs(s, now).map((j) => `${j.name} last checked ${ago(j.checkedAt, now)}`).join(", ")})`;
  else if (!s.checkedAt) line = "deputy: starting";
  else line = `deputy: ok, checked ${ago(s.checkedAt, now)}${failing.length ? `, ${failing.join(", ")} check failing` : ""}`;
  if (s?.posting === "draft") line += " · draft mode";
  if (held) line += ` · ${held} held for you (deputy held)`;
  return line;
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** The full report: the line, then the current run's PRs and stages, last run, last error. */
export function statusReport(s, { now = Date.now(), alive, held, runsDir }) {
  const out = [describeStatus(s, { now, alive, held })];
  if (!s) return out;
  out.push(`  running since ${s.startedAt}, pid ${s.pid}`);
  for (const [name, j] of Object.entries(s.jobs ?? {}))
    out.push(`  ${name}: every ${j.everyMinutes} min, checked ${ago(j.checkedAt, now)}${j.lastError ? `, failing: ${j.lastError}` : `, found ${j.lastFound ?? 0}`}`);
  for (const r of s.state === "running" && s.running ? s.running.items : []) {
    if (r.repo == null) { out.push(`  ${r.label}: running`); continue; }
    const dir = join(runsDir, runDirName(r.repo, r.number));
    const files = existsSync(dir) ? readdirSync(dir) : [];
    out.push(`  ${r.repo} #${r.number}: ${stageOf(files, r.number)}`);
  }
  if (s.lastRun) out.push(`  last run: ${s.lastRun.job} for ${s.lastRun.items.map((i) => i.label).join(", ")} ${ago(s.lastRun.at, now)}, exit ${s.lastRun.code}, log ${s.lastRun.log}`);
  return out;
}
