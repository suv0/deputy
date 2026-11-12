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

const hhmm = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * The one-line health summary, for a terminal or a status bar. Pure.
 * @param s           status.json contents, or null
 * @param alive       whether the core (s.pid) is a live process
 * @param guardAlive  whether the guard is a live process (it brings a stopped core back)
 * @param held        how many reviews wait in held/
 * @param stageFor    (item) => a running item's stage, or null
 */
export function describeStatus(s, { now = Date.now(), alive = false, guardAlive = false, held = 0, stageFor = () => null } = {}) {
  let line;
  const failing = Object.entries(s?.jobs ?? {}).filter(([, j]) => j.lastError).map(([n]) => n);
  const retrying = Object.entries(s?.jobs ?? {}).filter(([, j]) => j.retryAt && Date.parse(j.retryAt) > now);
  if (!s) line = "deputy: not started yet (deputy start)";
  else if (!alive || s.state === "stopped" || s.state === "reloading")
    line = guardAlive ? "deputy: restarting (the guard brings it back)" : `deputy: STOPPED (last check ${ago(s.checkedAt, now)})`;
  else if (s.state === "running" && s.running)
    line = `deputy: ${s.running.job} running for ${s.running.items.map((i) => { const st = stageFor(i); return st ? `${i.label}: ${st}` : i.label; }).join(", ")}`;
  else if (s.state === "paused" && s.paused) line = `deputy: PAUSED, ${s.paused.waiting} waiting (${s.paused.reason}). deputy resume starts runs again`;
  else if (retrying.length) line = `deputy: last run failed, retrying ${retrying.map(([n, j]) => `${n} at ${hhmm(j.retryAt)}`).join(", ")}`;
  else if (stuckJobs(s, now).length) line = `deputy: STUCK (${stuckJobs(s, now).map((j) => `${j.name} last checked ${ago(j.checkedAt, now)}`).join(", ")})`;
  else if (!s.checkedAt) line = "deputy: starting";
  else {
    line = `deputy: idle, checked ${ago(s.checkedAt, now)}${failing.length ? `, ${failing.join(", ")} check failing` : ""}`;
    if (s.lastRun) line += ` · last: ${s.lastRun.items.map((i) => i.label).join(", ")} at ${hhmm(s.lastRun.at)}`;
  }
  if (s?.posting === "draft") line += " · draft mode";
  if (held) line += ` · ${held} held for you (deputy held)`;
  return line;
}

/** Green, yellow or red for a status bar. Pure. */
export function colorOf(line) {
  if (/STOPPED|STUCK|not started|unreadable/.test(line)) return "error";
  if (/running|PAUSED|failed|failing|restarting|held for you/.test(line)) return "warning";
  return "success";
}

/** The status line with links for every PR it names, for a status bar. Pure. */
export function statusLinks(s) {
  const items = [...(s?.running?.items ?? []), ...(s?.lastRun?.items ?? [])].filter((i) => i.repo && i.number);
  const seen = new Set();
  return items.filter((i) => !seen.has(i.id) && seen.add(i.id))
    .map((i) => ({ text: `${i.repo.split("/")[1]} #${i.number}`, href: `https://github.com/${i.repo}/pull/${i.number}` }));
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** The full report: the line, then the current run's PRs and stages, last run, last error. */
export function stageForRun(runsDir) {
  return (i) => {
    if (i.repo == null) return null;
    const dir = join(runsDir, runDirName(i.repo, i.number));
    return stageOf(existsSync(dir) ? readdirSync(dir) : [], i.number);
  };
}

export function statusReport(s, { now = Date.now(), alive, guardAlive = false, held, runsDir }) {
  const out = [describeStatus(s, { now, alive, guardAlive, held, stageFor: stageForRun(runsDir) })];
  if (!s) return out;
  out.push(`  running since ${s.startedAt}, pid ${s.pid}`);
  for (const [name, j] of Object.entries(s.jobs ?? {}))
    out.push(`  ${name}: every ${j.everyMinutes} min, checked ${ago(j.checkedAt, now)}${j.lastError ? `, failing: ${j.lastError}` : `, found ${j.lastFound ?? 0}`}${j.failedRuns ? `, ${j.failedRuns} failed run(s) in a row, next try ${j.retryAt}` : ""}`);
  for (const r of s.state === "running" && s.running ? s.running.items : []) {
    if (r.repo == null) { out.push(`  ${r.label}: running`); continue; }
    const dir = join(runsDir, runDirName(r.repo, r.number));
    const files = existsSync(dir) ? readdirSync(dir) : [];
    out.push(`  ${r.label}: ${stageOf(files, r.number)}`);
  }
  if (s.lastRun) out.push(`  last run: ${s.lastRun.job} for ${s.lastRun.items.map((i) => i.label).join(", ")} ${ago(s.lastRun.at, now)}, exit ${s.lastRun.code}, log ${s.lastRun.log}`);
  return out;
}
