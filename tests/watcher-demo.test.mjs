import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, merge, paths as pathsOf } from "../src/config.mjs";
import { demo, fakeGh } from "../src/demo.mjs";
import { EventEmitter } from "node:events";
import { backoffMs, driverArgs, gist, lockHeld, nextDue, progressed, watch } from "../src/watcher.mjs";
import { restartDelayMs, supervise } from "../src/guard.mjs";
import { record } from "../src/checkout.mjs";
import { ROOT } from "../src/config.mjs";
import { readJson } from "../src/util.mjs";

function setup() {
  const state = mkdtempSync(join(tmpdir(), "deputy-watch-"));
  const config = merge(DEFAULTS, { github: { login: "you" }, repos: ["acme/shop"], stateDir: state });
  return { config, paths: pathsOf(config) };
}

const fakeJob = (name, found, over = {}) => ({ name, everyMinutes: 5, maxItemsPerRun: 2, check: async () => found(), prompt: () => "", label: (i) => i.id, ...over });

test("one cycle of the built-in job: finds the waiting PR, runs once, notifies, records the run", async () => {
  const { config, paths } = setup();
  const notes = [];
  let given = null;
  const runAgent = async ({ job, items }) => {
    given = { job: job.name, items };
    assert.ok(existsSync(paths.lock), "the lock is held during the run");
    record(paths.done, { job: "pr-review", id: items[0].id, version: items[0].version });
    return { code: 0, out: "## Done\nacme/shop #42: approved", log: "x.log" };
  };
  const status = await watch({ config, paths, gh: fakeGh(), notify: (t, b) => notes.push(`${t} | ${b}`), runAgent, once: true });
  assert.equal(given.job, "pr-review");
  assert.deepEqual(given.items.map((p) => p.number), [42], "only the PR that waits on you");
  assert.equal(given.items[0].id, "acme/shop#42");
  assert.equal(status.state, "idle");
  assert.equal(status.lastRun.code, 0);
  assert.equal(existsSync(paths.lock), false, "the lock is released");
  assert.match(notes[0], /^Reviewed: shop #42 \(let coupons stack checkout\)/);
  assert.equal(readJson(paths.status).lastRun.items[0].label, "shop #42 (let coupons stack checkout)");
});

test("a check that finds nothing starts no run", async () => {
  const { config, paths } = setup();
  let runs = 0;
  await watch({ config, paths, notify: () => {}, jobs: [fakeJob("quiet", () => [])], runAgent: async () => { runs++; return { code: 0 }; }, once: true });
  assert.equal(runs, 0);
  assert.equal(readJson(paths.status).jobs.quiet.lastFound, 0);
});

test("a run takes at most maxItemsPerRun items", async () => {
  const { config, paths } = setup();
  let size = 0;
  await watch({ config, paths, notify: () => {}, jobs: [fakeJob("busy", () => [{ id: "a" }, { id: "b" }, { id: "c" }])],
    runAgent: async ({ items }) => { size = items.length; return { code: 0, out: "", log: "" }; }, once: true });
  assert.equal(size, 2);
});

test("a failing check is recorded per job, and the third in a row pops up once", async () => {
  const { config, paths } = setup();
  const notes = [];
  let t = 0;
  const jobs = [fakeJob("flaky", () => { throw new Error("gh: HTTP 502"); }), fakeJob("fine", () => [])];
  await watch({ config, paths, notify: (title) => notes.push(title), jobs, now: () => t, wait: async (ms) => { t += ms; }, shouldStop: () => t > 15 * 60_000 });
  const s = readJson(paths.status);
  assert.equal(s.jobs.flaky.failuresInARow, 4);
  assert.equal(s.jobs.flaky.lastError, "gh: HTTP 502");
  assert.equal(s.jobs.fine.lastError, null);
  assert.deepEqual(notes, ["deputy: the flaky check keeps failing"]);
});

test("each job keeps its own timer", async () => {
  const { config, paths } = setup();
  const checks = [];
  let t = 0;
  const jobs = [
    fakeJob("fast", () => { checks.push(["fast", t]); return []; }, { everyMinutes: 5 }),
    fakeJob("slow", () => { checks.push(["slow", t]); return []; }, { everyMinutes: 15 }),
  ];
  await watch({ config, paths, notify: () => {}, jobs, now: () => t, wait: async (ms) => { t += ms; }, shouldStop: () => t > 30 * 60_000 });
  const at = (name) => checks.filter(([n]) => n === name).map(([, when]) => when / 60_000);
  assert.deepEqual(at("fast"), [0, 5, 10, 15, 20, 25, 30]);
  assert.deepEqual(at("slow"), [0, 15, 30]);
});

test("after a good run the job is checked again at once; after a failed run it waits", async () => {
  const { config, paths } = setup();
  const waits = [];
  let rounds = 0, code = 0;
  await watch({ config, paths, notify: () => {}, jobs: [fakeJob("one", () => [{ id: "x", version: String(code) }])], wait: async (ms) => waits.push(ms),
    runAgent: async () => ({ code: code++ === 0 ? 0 : 1, out: "", log: "" }), shouldStop: () => rounds++ >= 3 });
  assert.equal(waits.length, 1, "no wait after the good run, one after the failed run");
});

test("nextDue picks the earliest job", () => {
  assert.deepEqual(nextDue({ a: 500, b: 200 }, 100), { job: "b", waitMs: 100 });
  assert.deepEqual(nextDue({ a: 50 }, 100), { job: "a", waitMs: 0 });
  assert.deepEqual(nextDue({}, 100), { job: null, waitMs: 0 });
});

test("the lock holds while its process lives; a dead, old or unreadable lock never blocks", () => {
  const { paths } = setup();
  writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(lockHeld(paths.lock, 60_000), true);
  assert.equal(lockHeld(paths.lock, 60_000, Date.now() + 120_000), false, "older than the run limit");
  assert.equal(lockHeld(paths.lock, 60_000, Date.now(), () => false), false, "its process is gone");
  writeFileSync(paths.lock, "x");
  assert.equal(lockHeld(paths.lock, 60_000), false, "not the pid format");
});

test("backoffMs doubles from the job's timer and stops at an hour", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(5, n) / 60_000), [5, 5, 10, 20, 40, 60, 60]);
});

test("progressed: a run moved when an item left the check, or came back at a new version", () => {
  const batch = [{ id: "a", version: "1" }, { id: "b", version: "1" }];
  assert.equal(progressed(batch, [{ id: "a", version: "1" }, { id: "b", version: "1" }]), false);
  assert.equal(progressed(batch, [{ id: "a", version: "1" }]), true);
  assert.equal(progressed(batch, [{ id: "a", version: "1" }, { id: "b", version: "2" }]), true);
});

test("a run that exits 0 but handles nothing counts as failed and backs off", async () => {
  const { config, paths } = setup();
  const notes = [];
  let t = 0, runs = 0;
  const job = fakeJob("stuck", () => [{ id: "x", version: "1" }]);
  await watch({ config, paths, notify: (title) => notes.push(title), jobs: [job], now: () => t, wait: async (ms) => { t += ms; },
    runAgent: async () => { runs++; return { code: 0, out: "", log: "x.log" }; }, shouldStop: () => t > 40 * 60_000 });
  const s = readJson(paths.status);
  assert.equal(runs, 4, "runs at 0, 5, 15 and 35 minutes");
  assert.equal(s.jobs.stuck.failedRuns, 4);
  assert.ok(s.jobs.stuck.retryAt);
  assert.equal(notes.filter((n) => n === "deputy: stuck runs keep failing").length, 1);
  assert.match(notes[0], /stuck run failed, nothing handled/);
});

test("pause stops new runs while the checks go on", async () => {
  const { config, paths } = setup();
  writeFileSync(paths.pause, JSON.stringify({ reason: "on holiday" }));
  let runs = 0;
  const s = await watch({ config, paths, notify: () => {}, jobs: [fakeJob("one", () => [{ id: "x" }])], runAgent: async () => { runs++; return { code: 0 }; }, once: true });
  assert.equal(runs, 0);
  assert.equal(s.state, "paused");
  assert.equal(s.paused.waiting, 1);
});

test("the core returns to reload when its code changes, between runs", async () => {
  const { config, paths } = setup();
  let checks = 0;
  const s = await watch({ config, paths, notify: () => {}, jobs: [fakeJob("one", () => { checks++; return []; })], wait: async () => {}, codeChanged: () => checks >= 1 });
  assert.equal(s.reload, true);
  assert.equal(checks, 1);
});

test("the guard restarts at once after a reload, and backs off after crashes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(restartDelayMs), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  const cores = [], waits = [], logs = [];
  let t = 0;
  const startCore = () => { const c = new EventEmitter(); cores.push(c); return c; };
  const stop = supervise({ startCore, log: (l) => logs.push(l), later: (fn, ms) => { waits.push(ms); fn(); }, now: () => t });
  cores[0].emit("exit", 0);
  assert.equal(cores.length, 2, "a reload starts the core again at once");
  cores[1].emit("exit", 1); cores[2].emit("exit", 1);
  assert.deepEqual(waits, [30_000, 60_000]);
  t += 11 * 60_000;
  cores[3].emit("exit", 1);
  assert.deepEqual(waits, [30_000, 60_000, 30_000], "a core that ran 10 minutes resets the count");
  stop();
  cores[4].emit("exit", 1);
  assert.equal(cores.length, 5, "a stopped guard starts nothing");
});

test("gist flattens the end of a run's summary for a pop-up", () => {
  assert.equal(gist("noise\n## Summary\n- [PR 4](http://x) (cart): approved\n- `api` 9: held"), "noise · Summary · PR 4 (cart): approved · api 9: held");
});

test("the demo runs the whole review: posted in auto mode, held in draft mode", async () => {
  const quiet = () => {};
  const auto = await demo({ fast: true, popup: false, out: quiet });
  assert.equal(auto.outcome, "posted");
  assert.equal(auto.posted.length, 1);
  assert.equal(auto.posted[0].comments.length, 1, "the comment outside the diff moved into the body");
  const draft = await demo({ fast: true, popup: false, draft: true, out: quiet });
  assert.equal(draft.outcome, "held");
  assert.equal(draft.posted.length, 0);
});

test("a Claude driver gets the checkouts, deputy, the docs and the team file's folder; others are left alone", () => {
  const { config } = setup();
  const c = merge(config, { context: { docsDir: "/srv/docs", teamFile: "/srv/team/team.md", voiceFile: "/srv/docs/voice.md" } });
  const args = driverArgs(c);
  const dirs = args.filter((a, i) => args[i - 1] === "--add-dir");
  assert.deepEqual(dirs, [c.checkouts.root, ROOT, "/srv/docs", "/srv/team"], "folders already covered are not repeated");
  assert.deepEqual(driverArgs(c, { command: "my-agent", args: ["-p"] }), ["-p"]);
  assert.deepEqual(driverArgs(c, { command: "claude", args: ["-p", "--add-dir", "/x"] }), ["-p", "--add-dir", "/x"], "your own --add-dir wins");
});
