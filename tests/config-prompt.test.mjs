import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, merge, ROOT } from "../src/config.mjs";
import { checkConfig as validate } from "../src/jobs.mjs";
import { buildPrompt, renderTemplate } from "../src/prompt.mjs";
import { parseAnswer } from "../src/ask.mjs";
import { notifyCommand } from "../src/notify.mjs";
import { parseArgs, quoteWin } from "../src/util.mjs";

test("the example config is valid once login and repos are set", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "examples", "deputy.config.example.json"), "utf8"));
  const c = merge(DEFAULTS, example);
  assert.deepEqual(validate(c), ["github.login is not set"]);
  assert.deepEqual(validate(merge(c, { github: { login: "you" } })), []);
  assert.equal(c.posting, "draft", "new installs start in draft mode");
});

test("validate catches the settings that would misbehave", () => {
  const c = merge(DEFAULTS, { github: { login: "you" }, repos: ["not a repo"], posting: "yes", verdict: { requestChanges: "maybe" }, models: { tiers: { review: [] } } });
  const problems = validate(c).join("\n");
  for (const bit of ["not owner/name", "posting", "requestChanges", "models.tiers.review"]) assert.match(problems, new RegExp(bit));
});

test("merge replaces arrays and merges objects", () => {
  assert.deepEqual(merge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } }), { a: { b: 1, c: [3] } });
});

test("loadConfig resolves paths against the config file and finds the built-in checklist", () => {
  const dir = mkdtempSync(join(tmpdir(), "deputy-config-"));
  const file = join(dir, "deputy.config.json");
  writeFileSync(file, JSON.stringify({ github: { login: "you" }, repos: ["a/b"], stateDir: "state", context: { teamFile: "team.md" } }));
  const c = loadConfig(file);
  assert.equal(c.stateDir, join(dir, "state"));
  assert.equal(c.context.teamFile, join(dir, "team.md"));
  assert.equal(c.context.checklist, join(ROOT, "checklist", "review-checklist.md"));
});

test("renderTemplate: values, sections and inverted sections", () => {
  const t = "Hi {{NAME}}.{{#DOCS}} Docs: {{DOCS}}.{{/DOCS}}{{^DOCS}} No docs.{{/DOCS}}{{MISSING}}";
  assert.equal(renderTemplate(t, { NAME: "you", DOCS: "/d" }), "Hi you. Docs: /d.");
  assert.equal(renderTemplate(t, { NAME: "you", DOCS: "" }), "Hi you. No docs.");
});

test("the review prompt carries the config and nothing unrendered", () => {
  const c = merge(DEFAULTS, { github: { login: "octo" }, repos: ["acme/shop"] });
  const p = buildPrompt(c, [{ repo: "acme/shop", number: 7 }]);
  assert.match(p, /for octo on GitHub/);
  assert.match(p, /Posting mode is \*\*draft\*\*/);
  assert.match(p, /"number": 7/);
  assert.doesNotMatch(p, /\{\{|\}\}/);
  assert.doesNotMatch(p, /docs folder/, "no docs lines when no docs are set up");
  const auto = buildPrompt(merge(c, { posting: "auto", context: { docsDir: "/srv/docs" } }), []);
  assert.match(auto, /posted without asking octo/);
  assert.match(auto, /\/srv\/docs/);
});

test("parseAnswer reads the answer window's output", () => {
  assert.deepEqual(parseAnswer("yes\r\n"), { answer: "yes" });
  assert.deepEqual(parseAnswer("noise\nno"), { answer: "no" });
  assert.deepEqual(parseAnswer("text: use the newer doc "), { answer: "text", text: "use the newer doc" });
  assert.deepEqual(parseAnswer("text:   "), { answer: "none" });
  assert.deepEqual(parseAnswer(""), { answer: "none" });
});

test("notifyCommand per OS, with quotes escaped", () => {
  assert.match(notifyCommand("win32", "it's", "b")[1].at(-1), /it''s/);
  assert.equal(notifyCommand("darwin", "t", 'say "hi"')[0], "osascript");
  assert.match(notifyCommand("darwin", "t", 'say "hi"')[1][1], /say \\"hi\\"/);
  assert.deepEqual(notifyCommand("linux", "t", "b"), ["notify-send", ["--app-name=deputy", "t", "b"]]);
  assert.equal(notifyCommand("aix", "t", "b"), null);
});

test("parseArgs and quoteWin", () => {
  assert.deepEqual(parseArgs(["post", "f.json", "--post", "--since=2h", "--tier", "review"]), { _: ["post", "f.json"], post: true, since: "2h", tier: "review" });
  assert.equal(quoteWin("plain"), "plain");
  assert.equal(quoteWin("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
  assert.equal(quoteWin('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWin(""), '""');
});
