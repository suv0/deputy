import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorOf, describeStatus, stageOf, statusLinks, statusReport, stuckJobs } from "../src/status.mjs";

const now = Date.parse("2026-11-11T12:00:00Z");
const job = (over = {}) => ({ everyMinutes: 5, checkedAt: "2026-11-11T11:58:00Z", lastError: null, failuresInARow: 0, lastFound: 0, ...over });
const base = { pid: 1, startedAt: "2026-11-11T08:00:00Z", checkedAt: "2026-11-11T11:58:00Z", state: "idle", running: null, lastRun: null, lastError: null, posting: "auto", jobs: { "pr-review": job() } };

test("not started, stopped, dead process", () => {
  assert.match(describeStatus(null, { now }), /not started/);
  assert.match(describeStatus({ ...base, state: "stopped" }, { now, alive: true }), /STOPPED/);
  assert.match(describeStatus(base, { now, alive: false }), /STOPPED \(last check 2m ago\)/);
});

test("healthy, and a failing check named", () => {
  assert.equal(describeStatus(base, { now, alive: true }), "deputy: idle, checked 2m ago");
  const failing = { ...base, jobs: { ...base.jobs, "failing-ci": job({ lastError: "gh: timed out" }) } };
  assert.equal(describeStatus(failing, { now, alive: true }), "deputy: idle, checked 2m ago, failing-ci check failing");
});

test("a job whose check is more than two cycles old reads as stuck", () => {
  const slow = { ...base, jobs: { "pr-review": job({ checkedAt: "2026-11-11T11:40:00Z" }), "issues": job({ everyMinutes: 30, checkedAt: "2026-11-11T11:40:00Z" }) } };
  assert.equal(describeStatus(slow, { now, alive: true }), "deputy: STUCK (pr-review last checked 20m ago)");
  assert.deepEqual(stuckJobs({ ...slow, state: "running", running: { job: "x", items: [] } }, now), [], "never stuck while a run is going");
});

test("running names the job and its items", () => {
  const s = { ...base, state: "running", running: { job: "pr-review", items: [{ id: "acme/shop#42", label: "shop #42", repo: "acme/shop", number: 42 }] } };
  assert.equal(describeStatus(s, { now, alive: true }), "deputy: pr-review running for shop #42");
});

test("draft mode and held reviews are shown", () => {
  assert.equal(describeStatus({ ...base, posting: "draft" }, { now, alive: true, held: 2 }), "deputy: idle, checked 2m ago · draft mode · 2 held for you (deputy held)");
});

test("stageOf follows the run folder's files in order", () => {
  assert.equal(stageOf([], 4), "setting up");
  assert.equal(stageOf(["facts-brief.md"], 4), "gathering facts");
  assert.equal(stageOf(["facts-brief.md", "facts.md", "brief.md"], 4), "review model is reviewing");
  assert.equal(stageOf(["brief.md", "answer.md", "challenge-brief.md"], 4), "challenge model is trying to disprove the draft");
  assert.equal(stageOf(["answer.md", "review-4.json"], 4), "checking the draft, about to post");
  assert.equal(stageOf(["review-4.json", "held-4"], 4), "held for you");
  assert.equal(stageOf(["review-4.json", "send-4.json"], 4), "posted");
});

test("statusReport lists each job, and each PR's stage from its run folder", () => {
  const runs = mkdtempSync(join(tmpdir(), "deputy-status-"));
  mkdirSync(join(runs, "acme-shop-42"));
  writeFileSync(join(runs, "acme-shop-42", "answer.md"), "");
  const s = { ...base, state: "running", running: { job: "pr-review", items: [
    { id: "acme/shop#42", label: "shop #42", repo: "acme/shop", number: 42 },
    { id: "acme/shop#43", label: "shop #43", repo: "acme/shop", number: 43 },
  ] } };
  const lines = statusReport(s, { now, alive: true, held: 0, runsDir: runs });
  assert.ok(lines.includes("  pr-review: every 5 min, checked 2m ago, found 0"));
  assert.ok(lines.includes("  shop #42: review drafted, checking claims in the code"));
  assert.ok(lines.includes("  shop #43: setting up"));
  assert.match(lines[0], /running for shop #42: review drafted, checking claims in the code, shop #43: setting up/);
});

test("a job that just finished a long run is not stuck", () => {
  const s = { ...base, jobs: { "pr-review": job({ checkedAt: "2026-11-11T11:30:00Z" }) }, lastRun: { job: "pr-review", at: "2026-11-11T11:59:00Z", items: [], code: 0 } };
  assert.deepEqual(stuckJobs(s, now), []);
});

test("restarting, paused, retrying and the last run when idle", () => {
  assert.equal(describeStatus({ ...base, state: "stopped" }, { now, alive: false, guardAlive: true }), "deputy: restarting (the guard brings it back)");
  assert.match(describeStatus({ ...base, state: "paused", paused: { reason: "holiday", waiting: 2 } }, { now, alive: true }), /PAUSED, 2 waiting \(holiday\)/);
  const retry = { ...base, jobs: { "pr-review": job({ retryAt: "2026-11-11T12:20:00Z", failedRuns: 2 }) } };
  assert.match(describeStatus(retry, { now, alive: true }), /last run failed, retrying pr-review at/);
  const idle = { ...base, lastRun: { job: "pr-review", at: "2026-11-11T11:00:00Z", items: [{ label: "shop #42 (coupons stack)" }], code: 0 } };
  assert.match(describeStatus(idle, { now, alive: true }), /idle, checked 2m ago · last: shop #42 \(coupons stack\) at /);
});

test("colorOf and statusLinks for a status bar", () => {
  assert.equal(colorOf("deputy: idle, checked 2m ago"), "success");
  assert.equal(colorOf("deputy: pr-review running for shop #42"), "warning");
  assert.equal(colorOf("deputy: STOPPED (last check 1h ago)"), "error");
  const s = { running: { items: [{ id: "acme/shop#42", repo: "acme/shop", number: 42 }] }, lastRun: { items: [{ id: "acme/shop#42", repo: "acme/shop", number: 42 }, { id: "x", label: "x" }] } };
  assert.deepEqual(statusLinks(s), [{ text: "shop #42", href: "https://github.com/acme/shop/pull/42" }]);
});
