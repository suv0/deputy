import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, merge, paths as pathsOf } from "../src/config.mjs";
import { checkConfig, jobProblems, loadJobs, selectFresh } from "../src/jobs.mjs";
import { formatGithubFacts, record } from "../src/checkout.mjs";
import { readJson } from "../src/util.mjs";

test("selectFresh drops items handled at the same version, and keeps them when it changes", () => {
  const done = { "ci:a": { version: "1" }, "ci:b": { version: "1" }, "other:c": { version: "1" }, "ci:d": { version: "x" } };
  const items = [{ id: "a", version: "1" }, { id: "b", version: "2" }, { id: "c", version: "1" }, { id: "d" }, { id: "e" }, { id: "e" }];
  assert.deepEqual(selectFresh("ci", items, done).map((i) => i.id), ["b", "c", "e"], "an item with no version is handled once");
  assert.equal(selectFresh("ci", [{ id: 7, version: 3 }])[0].id, "7", "ids and versions become strings");
});

test("selectFresh refuses output that isn't a list of items with ids", () => {
  assert.throws(() => selectFresh("ci", { id: "a" }), /JSON list/);
  assert.throws(() => selectFresh("ci", [{ title: "no id" }]), /needs an "id"/);
});

test("record and selectFresh agree on the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "deputy-jobs-"));
  const done = join(dir, "done.json");
  record(done, { job: "ci", id: "acme/shop#4", version: "abc", outcome: "fixed" });
  assert.equal(selectFresh("ci", [{ id: "acme/shop#4", version: "abc" }], readJson(done)).length, 0);
  assert.equal(readJson(done)["ci:acme/shop#4"].outcome, "fixed");
});

test("jobProblems checks names, builtins, checks and prompt files", () => {
  const c = merge(DEFAULTS, { jobs: [
    { name: "pr-review", builtin: "pr-review" },
    { name: "pr-review", builtin: "pr-review" },
    { name: "bad name!", builtin: "nope" },
    { name: "ci", check: "node check.mjs", prompt: "missing.md" },
  ] });
  const p = jobProblems(c).join("\n");
  for (const bit of ["two jobs are named", "letters, digits", "unknown builtin", "command list", "missing.md not found"]) assert.match(p, new RegExp(bit));
});

test("without the PR job, no GitHub login or repos are needed", () => {
  const c = merge(DEFAULTS, { jobs: [{ name: "failing-ci", check: ["node", "examples/jobs/failing-ci/check.mjs", "a/b"], prompt: "examples/jobs/failing-ci/prompt.md" }] });
  assert.deepEqual(checkConfig(c), []);
});

test("a command job runs its check, filters by done, and renders its prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deputy-cmdjob-"));
  writeFileSync(join(dir, "check.mjs"), `console.log(JSON.stringify([{ id: "x", version: "2", title: "item x" }, { id: "y", version: "1" }]));`);
  writeFileSync(join(dir, "prompt.md"), "Job {{JOB}} for {{WHO}}: {{ITEMS_JSON}} via {{DEPUTY}}");
  writeFileSync(join(dir, "deputy.config.json"), JSON.stringify({ stateDir: "state", jobs: [{ name: "mine", check: ["node", "check.mjs"], prompt: "prompt.md", vars: { WHO: "the team" } }] }));
  const config = loadConfig(join(dir, "deputy.config.json"));
  assert.deepEqual(checkConfig(config), []);
  const [job] = loadJobs(config);
  const items = await job.check({ done: { "mine:y": { version: "1" } }, paths: pathsOf(config) });
  assert.deepEqual(items.map((i) => i.id), ["x"]);
  assert.equal(job.label(items[0]), "item x");
  const prompt = job.prompt(items);
  assert.match(prompt, /^Job mine for the team: \[/);
  assert.match(prompt, /deputy\.mjs/);
});

test("a check that fails or prints junk is an error, not an empty list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deputy-cmdjob-"));
  writeFileSync(join(dir, "fail.mjs"), `console.error("no token"); process.exit(3);`);
  writeFileSync(join(dir, "junk.mjs"), `console.log("hello");`);
  writeFileSync(join(dir, "p.md"), "x");
  writeFileSync(join(dir, "deputy.config.json"), JSON.stringify({ jobs: [
    { name: "fail", check: ["node", "fail.mjs"], prompt: "p.md" }, { name: "junk", check: ["node", "junk.mjs"], prompt: "p.md" },
  ] }));
  const config = loadConfig(join(dir, "deputy.config.json"));
  const [fail, junk] = loadJobs(config);
  await assert.rejects(fail.check({ done: {}, paths: pathsOf(config) }), /exited 3: no token/);
  await assert.rejects(junk.check({ done: {}, paths: pathsOf(config) }), /not JSON/);
});

test("disabled jobs don't load", () => {
  const c = merge(DEFAULTS, { github: { login: "you" }, repos: ["a/b"], jobs: [{ name: "pr-review", builtin: "pr-review", enabled: false }] });
  assert.equal(loadJobs(c).length, 0);
});

test("formatGithubFacts writes what GitHub knows, and says unknown where it couldn't read", () => {
  const pr = { ok: true, value: {
    title: "Count once after commit", url: "u", author: { login: "maya" }, baseRefName: "main", headRefOid: "abc",
    body: "Closes the counter bug.", labels: [{ name: "bug" }], closingIssuesReferences: [{ number: 7 }],
    files: [{ path: "src/a.js", additions: 3, deletions: 1 }],
    reviews: [{ author: { login: "leo" }, state: "COMMENTED", commit: { oid: "abcdef1234" }, body: "One question." }],
    comments: [], statusCheckRollup: [{ name: "tests", conclusion: "FAILURE" }],
  } };
  const md = formatGithubFacts({ repo: "acme/shop", n: 4, pr, inline: { ok: false, error: "HTTP 502" },
    open: { ok: true, value: [{ number: 5, title: "Other", author: { login: "sam" }, files: [{ path: "src/a.js" }] }, { number: 4, files: [{ path: "src/a.js" }] }] },
    logs: [{ name: "tests", runId: "9", tail: "Error: boom" }] });
  for (const bit of ["## Count once after commit", "Closes: #7", "- src/a.js (+3/-1)", "leo COMMENTED at abcdef123: One question.", "unknown (HTTP 502)", "- tests: FAILURE", "Error: boom", "- #5 Other (sam): src/a.js"])
    assert.ok(md.includes(bit), bit);
  assert.ok(!md.includes("#4 "), "the PR itself is not its own overlap");
  assert.match(formatGithubFacts({ repo: "a/b", n: 1, pr: { ok: false, error: "gone" } }), /PR: unknown \(gone\)/);
});
