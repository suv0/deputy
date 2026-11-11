import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, merge, paths as pathsOf } from "../src/config.mjs";
import { listHeld, postReview } from "../src/post.mjs";
import { fakeGh } from "../src/demo.mjs";

const HEAD = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";

function setup(over = {}, payloadOver = {}) {
  const state = mkdtempSync(join(tmpdir(), "deputy-post-"));
  const config = merge(DEFAULTS, { github: { login: "you" }, repos: ["acme/shop"], stateDir: state, ...over });
  const paths = pathsOf(config);
  const file = join(state, "review-42.json");
  const payload = { _repo: "acme/shop", _number: 42, commit_id: HEAD, _head_sha: HEAD, event: "APPROVE", body: "Looks right.", comments: [{ path: "src/cart/total.js", line: 17, side: "RIGHT", body: "x" }], ...payloadOver };
  writeFileSync(file, JSON.stringify(payload));
  const posted = [];
  return { config, paths, file, posted, gh: fakeGh(posted), state };
}

test("a dry run checks without posting", async () => {
  const s = setup({ posting: "auto" });
  const r = await postReview({ ...s });
  assert.equal(r.outcome, "checked");
  assert.equal(s.posted.length, 0);
});

test("draft mode holds the review even with --post", async () => {
  const s = setup();
  const r = await postReview({ ...s, doPost: true });
  assert.equal(r.outcome, "held");
  assert.equal(s.posted.length, 0);
  const held = listHeld(s.paths.held);
  assert.equal(held.length, 1);
  assert.match(held[0].why, /draft mode/);
  assert.ok(readdirSync(s.state).includes("held-42"), "the run folder shows the hold");
});

test("auto mode posts, and reads the review back", async () => {
  const s = setup({ posting: "auto" });
  const r = await postReview({ ...s, doPost: true });
  assert.equal(r.outcome, "posted");
  assert.equal(s.posted.length, 1);
  assert.equal(s.posted[0].event, "APPROVE");
  assert.ok(existsSync(join(s.state, "send-42.json")));
});

test("auto mode still holds a REQUEST_CHANGES draft under the default policy", async () => {
  const s = setup({ posting: "auto" }, { event: "REQUEST_CHANGES" });
  const r = await postReview({ ...s, doPost: true });
  assert.equal(r.outcome, "held");
  assert.equal(s.posted.length, 0);
});

test("soften posts an approval with a CAUTION instead", async () => {
  const s = setup({ posting: "auto", verdict: { approveEvent: "APPROVE", requestChanges: "soften" } }, { event: "REQUEST_CHANGES" });
  await postReview({ ...s, doPost: true });
  assert.equal(s.posted[0].event, "APPROVE");
  assert.match(s.posted[0].body, /^> \[!CAUTION\]/);
});

test("a moved head or a bad anchor stops it, even in auto mode", async () => {
  const moved = setup({ posting: "auto" }, { commit_id: "a".repeat(40), _head_sha: "a".repeat(40) });
  const r1 = await postReview({ ...moved, doPost: true });
  assert.equal(r1.outcome, "invalid");
  assert.ok(r1.lines.some((l) => l.includes("head moved")));

  const anchor = setup({ posting: "auto" }, { comments: [{ path: "src/cart/total.js", line: 99, body: "x" }] });
  const r2 = await postReview({ ...anchor, doPost: true });
  assert.equal(r2.outcome, "invalid");
  assert.equal(anchor.posted.length, 0);
});

test("a thread reply must answer a top-level comment of the PR", async () => {
  const s = setup({ posting: "auto" }, { _thread_replies: [{ in_reply_to: 123, body: "Checked: fixed." }] });
  const r = await postReview({ ...s, doPost: true });
  assert.equal(r.outcome, "invalid");
  assert.ok(r.lines.some((l) => l.includes("reply target 123")));
});

test("force (a person posting a held review) posts in draft mode", async () => {
  const s = setup();
  const r = await postReview({ ...s, doPost: true, force: true });
  assert.equal(r.outcome, "posted");
});

test("the docs tip is checked when refreshDocs is on", async () => {
  const s = setup({ posting: "auto", context: { ...DEFAULTS.context, docsDir: "/docs", refreshDocs: true } }, { _docs_commit: "abc1234" });
  const r = await postReview({ ...s, doPost: true, getDocsTip: async () => "def5678" });
  assert.equal(r.outcome, "invalid");
  assert.ok(r.lines.some((l) => l.includes("docs moved to def5678")));
});
