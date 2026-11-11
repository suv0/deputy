import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVerdictPolicy, checkShape, SOFTEN_PREFIX, verdictLabel } from "../src/verdict.mjs";

const rc = { event: "REQUEST_CHANGES", body: "This drops every order on retry.", comments: [] };
const policy = (over) => ({ approveEvent: "APPROVE", requestChanges: "hold", ...over });

test("hold: a REQUEST_CHANGES draft is held, unchanged", () => {
  const r = applyVerdictPolicy(rc, policy());
  assert.match(r.hold, /requests changes/);
  assert.equal(r.payload.event, "REQUEST_CHANGES");
});

test("soften: REQUEST_CHANGES becomes an approval led by a red CAUTION", () => {
  const r = applyVerdictPolicy(rc, policy({ requestChanges: "soften" }));
  assert.equal(r.hold, null);
  assert.equal(r.payload.event, "APPROVE");
  assert.ok(r.payload.body.startsWith(SOFTEN_PREFIX));
  assert.ok(r.payload.body.endsWith(rc.body));
  assert.equal(rc.event, "REQUEST_CHANGES", "the input is not changed");
});

test("soften doesn't add a second CAUTION when the body has one", () => {
  const body = "> [!CAUTION]\n> **Do not merge until the retry is idempotent.**";
  const r = applyVerdictPolicy({ ...rc, body }, policy({ requestChanges: "soften" }));
  assert.equal(r.payload.body, body);
});

test("allow: REQUEST_CHANGES goes through", () => {
  const r = applyVerdictPolicy(rc, policy({ requestChanges: "allow" }));
  assert.equal(r.hold, null);
  assert.equal(r.payload.event, "REQUEST_CHANGES");
});

test("approveEvent COMMENT turns approvals, softened ones too, into comments", () => {
  assert.equal(applyVerdictPolicy({ event: "APPROVE", body: "ok" }, policy({ approveEvent: "COMMENT" })).payload.event, "COMMENT");
  assert.equal(applyVerdictPolicy(rc, policy({ approveEvent: "COMMENT", requestChanges: "soften" })).payload.event, "COMMENT");
});

test("an unknown event is held", () => {
  assert.match(applyVerdictPolicy({ event: "LGTM", body: "x" }, policy()).hold, /unknown event/);
});

test("verdictLabel reads the alerts", () => {
  assert.equal(verdictLabel({ event: "APPROVE", body: "fine" }), "approved");
  assert.equal(verdictLabel({ event: "APPROVE", body: "> [!WARNING]\n> later" }), "approved with a warning");
  assert.equal(verdictLabel({ event: "APPROVE", body: "> [!CAUTION]\n> **Do not merge until x**" }), "approved, do not merge yet");
  assert.equal(verdictLabel({ event: "REQUEST_CHANGES", body: "x" }), "changes requested");
});

test("checkShape needs repo, number, full sha, event and body", () => {
  const good = { _repo: "acme/shop", _number: 4, commit_id: "a".repeat(40), _head_sha: "a".repeat(40), event: "APPROVE", body: "ok", comments: [] };
  assert.deepEqual(checkShape(good), []);
  assert.equal(checkShape({ ...good, _head_sha: "b".repeat(40) }).length, 1);
  assert.equal(checkShape({ ...good, commit_id: "abc1234", _head_sha: undefined }).length, 1);
  assert.equal(checkShape({ ...good, body: "  " }).length, 1);
  assert.equal(checkShape({ ...good, _thread_replies: [{ in_reply_to: "7", body: "x" }] }).length, 1);
  assert.equal(checkShape({}).length, 5);
});
