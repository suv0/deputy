import { test } from "node:test";
import assert from "node:assert/strict";
import { findPending, selectPending, summarizeReviews } from "../src/pending.mjs";

const pr = (n, over = {}) => ({
  number: n, title: `PR ${n}`, author: { login: "maya" }, headRefOid: `${n}`.repeat(40).slice(0, 40), baseRefName: "main",
  isDraft: false, state: "OPEN", mergedAt: null, additions: 1, deletions: 1, reviewRequests: [{ login: "you" }], url: `u/${n}`, ...over,
});

test("keeps open, ready PRs that request you, oldest first", () => {
  const out = selectPending("acme/shop", [pr(9), pr(3)], { login: "you" });
  assert.deepEqual(out.map((p) => p.number), [3, 9]);
});

test("leaves out drafts, closed, merged, your own and other people's requests", () => {
  const rows = [
    pr(1, { isDraft: true }),
    pr(2, { state: "CLOSED" }),
    pr(3, { mergedAt: "2026-01-01T00:00:00Z" }),
    pr(4, { author: { login: "You" } }),
    pr(5, { reviewRequests: [{ login: "someone-else" }] }),
    pr(6, { reviewRequests: [] }),
    pr(7),
  ];
  assert.deepEqual(selectPending("acme/shop", rows, { login: "you" }).map((p) => p.number), [7]);
});

test("login matching ignores case", () => {
  assert.equal(selectPending("a/b", [pr(1, { reviewRequests: [{ login: "YOU" }] })], { login: "you" }).length, 1);
});

test("a request to one of your teams counts, by slug or name, with or without the org", () => {
  const rows = [
    pr(1, { reviewRequests: [{ slug: "acme/reviewers", name: "Reviewers" }] }),
    pr(2, { reviewRequests: [{ name: "backend" }] }),
    pr(3, { reviewRequests: [{ slug: "acme/design" }] }),
  ];
  const out = selectPending("acme/shop", rows, { login: "you", teams: ["reviewers", "acme/backend"] });
  assert.deepEqual(out.map((p) => p.number), [1]);
  const out2 = selectPending("acme/shop", rows, { login: "you", teams: ["Reviewers", "backend"] });
  assert.deepEqual(out2.map((p) => p.number), [1, 2]);
});

test("a head already handled is skipped until the PR moves", () => {
  const p = pr(5);
  assert.equal(selectPending("acme/shop", [p], { login: "you", done: { "pr-review:acme/shop#5": { head: p.headRefOid } } }).length, 0);
  assert.equal(selectPending("acme/shop", [p], { login: "you", done: { "pr-review:acme/shop#5": p.headRefOid } }).length, 0, "old string form");
  assert.equal(selectPending("acme/shop", [p], { login: "you", done: { "pr-review:acme/shop#5": { head: "f".repeat(40) } } }).length, 1);
  assert.equal(selectPending("acme/other", [p], { login: "you", done: { "pr-review:acme/shop#5": { head: p.headRefOid } } }).length, 1, "keys are per repo");
});

test("summarizeReviews: re-review, your last commit, approvals at this head only", () => {
  const reviews = [
    { user: { login: "you" }, state: "APPROVED", commit_id: "old1" },
    { user: { login: "leo" }, state: "APPROVED", commit_id: "head" },
    { user: { login: "sam" }, state: "APPROVED", commit_id: "old1" },
    { user: { login: "you" }, state: "COMMENTED", commit_id: "old2" },
    { user: { login: "kim" }, state: "APPROVED", commit_id: "head" },
    { user: { login: "kim" }, state: "CHANGES_REQUESTED", commit_id: "head" },
  ];
  assert.deepEqual(summarizeReviews(reviews, "you", "head"), { reReview: true, myLastReviewedCommit: "old2", approvedAtHeadBy: ["leo"] });
  assert.deepEqual(summarizeReviews([], "you", "head"), { reReview: false, myLastReviewedCommit: null, approvedAtHeadBy: [] });
});

test("findPending asks gh per repo and enriches each PR", async () => {
  const calls = [];
  const gh = {
    json: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "pr") return args[3] === "acme/shop" ? [pr(4), pr(5, { isDraft: true })] : [];
      return [[{ user: { login: "leo" }, state: "APPROVED", commit_id: pr(4).headRefOid }]];
    },
  };
  const out = await findPending({ config: { repos: ["acme/shop", "acme/docs"], github: { login: "you", teams: [] } }, gh, done: {} });
  assert.equal(out.length, 1);
  assert.equal(out[0].repo, "acme/shop");
  assert.deepEqual(out[0].approvedAtHeadBy, ["leo"]);
  assert.equal(calls.filter((c) => c.startsWith("api")).length, 1, "reviews fetched only for kept PRs");
});
