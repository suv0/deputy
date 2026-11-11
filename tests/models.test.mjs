import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askModel, downUntil, planCandidates, readUsage, sinceOf, takeDidLine, usageSummary } from "../src/models.mjs";
import { readJson } from "../src/util.mjs";

const models = {
  tiers: {
    legwork: [{ tool: "command-code", model: "cheap-1" }, { tool: "codex", model: "cheap-2", effort: "medium" }],
    review: [{ tool: "codex", model: "strong-1", effort: "high" }, { tool: "claude", model: "sonnet" }],
  },
};

test("planCandidates follows the tier's order and skips tools that are down", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const down = { codex: { until: "2026-11-11T13:00:00Z" }, claude: { until: "2026-11-11T11:00:00Z" } };
  const { usable, skipped } = planCandidates(models, { tier: "review" }, down, now);
  assert.deepEqual(usable.map((c) => c.model), ["sonnet"], "an expired down entry no longer counts");
  assert.deepEqual(skipped.map((c) => c.model), ["strong-1"]);
});

test("an exact --tool/--model goes first; --effort overrides the tier's", () => {
  const { usable } = planCandidates(models, { tier: "legwork", tool: "opencode", model: "x", effort: "low" });
  assert.deepEqual(usable.map((c) => `${c.tool}:${c.model}:${c.effort}`), ["opencode:x:low", "command-code:cheap-1:low", "codex:cheap-2:low"]);
  assert.throws(() => planCandidates(models, { tool: "codex" }), /go together/);
  assert.throws(() => planCandidates(models, { tier: "nope" }), /unknown tier/);
});

test("downUntil spots account limits and reads a reset time", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.equal(downUntil("You've hit your usage limit. Resets at 2026-11-12T09:00:00Z", now), "2026-11-12T09:00:00Z");
  assert.equal(downUntil("HTTP 429 Too Many Requests", now), "2026-11-11T12:15:00.000Z");
  assert.equal(downUntil("SyntaxError in the answer", now), null);
});

test("takeDidLine keeps the note and drops it from the answer", () => {
  assert.deepEqual(takeDidLine("Answer.\n\n**DID:** read three files\n"), { text: "Answer.\n", did: "read three files" });
  assert.equal(takeDidLine("Just an answer").did, "Just an answer");
});

test("askModel falls back, marks a tool down, and logs every attempt", async () => {
  const state = mkdtempSync(join(tmpdir(), "deputy-models-"));
  const paths = { down: join(state, "down.json"), usage: join(state, "runs.jsonl") };
  const seen = [];
  const runner = {
    codex: async (c, o) => { seen.push(c.model); assert.match(o.prompt, /DID:/); return { ok: false, error: "usage limit reached", tokens: 10 }; },
    claude: async (c) => { seen.push(c.model); return { ok: true, text: "Fine.\nDID: reviewed it", tokens: 99 }; },
  };
  const r = await askModel({ config: { models }, paths, prompt: "review", tier: "review", label: "t1", runner, log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.text, "Fine.\n");
  assert.deepEqual(seen, ["strong-1", "sonnet"]);
  assert.ok(readJson(paths.down, {}).codex, "codex remembered as down");
  const usage = readUsage(paths.usage);
  assert.equal(usage.length, 2);
  assert.equal(usage[1].did, "reviewed it");

  seen.length = 0;
  await askModel({ config: { models }, paths, prompt: "again", tier: "review", runner, log: () => {} });
  assert.deepEqual(seen, ["sonnet"], "the down tool is skipped next time");

  const s = usageSummary(readUsage(paths.usage), 0);
  assert.equal(s.runs, 3);
  assert.match(s.line, /sonnet ×2/);
});

test("askModel with no working model reports every attempt", async () => {
  const state = mkdtempSync(join(tmpdir(), "deputy-models-"));
  const paths = { down: join(state, "down.json"), usage: join(state, "runs.jsonl") };
  const runner = { "command-code": async () => ({ ok: false, error: "crashed" }), codex: async () => ({ ok: false, error: "timed out" }) };
  const r = await askModel({ config: { models }, paths, prompt: "x", tier: "legwork", runner, log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 2);
});

test("sinceOf understands today, durations and ISO times", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.equal(sinceOf("2h", now), now - 7_200_000);
  assert.equal(sinceOf("all", now), 0);
  assert.equal(sinceOf("2026-11-10T00:00:00Z", now), Date.parse("2026-11-10T00:00:00Z"));
  assert.throws(() => sinceOf("yesterday-ish", now));
});
