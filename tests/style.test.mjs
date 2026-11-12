import { test } from "node:test";
import assert from "node:assert/strict";
import { payloadStyleProblems, styleProblems } from "../src/style.mjs";

const style = { noDashes: true, maxSentences: 3, maxParagraphChars: 350, team: { Maya: "maya", Sam: { login: "sam", honorific: "ji" } } };

test("clean text passes", () => {
  assert.deepEqual(styleProblems("body", "@maya, the retry waits between tries now. Approving.\n\n> [!WARNING]\n> One thing for later.", style), []);
});

test("em and en dashes are refused, but not inside code", () => {
  assert.equal(styleProblems("body", "Looks right — mostly.", style).length, 1);
  assert.equal(styleProblems("body", "Pages 3–5.", style).length, 1);
  assert.deepEqual(styleProblems("body", "Run `a — b` and\n```\nx – y\n```", style), []);
  assert.deepEqual(styleProblems("body", "Looks right — mostly.", { ...style, noDashes: false }), []);
});

test("long paragraphs are refused; lists and code don't count", () => {
  const four = "One thing. Two things. Three things. Four things.";
  assert.match(styleProblems("body", four, style)[0], /4 sentences/);
  assert.deepEqual(styleProblems("body", "One. Two.\n\nThree. Four.", style), []);
  assert.deepEqual(styleProblems("body", "- One. Two. Three. Four. Five.", style), [], "a list line is left alone");
  assert.match(styleProblems("body", "x".repeat(351), style)[0], /351 characters/);
  assert.deepEqual(styleProblems("body", `See [the doc](${"https://e.com/" + "a".repeat(400)}).`, style), [], "link targets don't count");
  assert.deepEqual(styleProblems("body", four, { ...style, maxSentences: 0 }), [], "0 turns it off");
});

test("a team member is named only by their tag", () => {
  assert.match(styleProblems("body", "Maya, can you check this?", style)[0], /names Maya without the tag; write @maya/);
  assert.deepEqual(styleProblems("body", "@maya, can you check this?", style), []);
  assert.deepEqual(styleProblems("body", "See `Maya` in the code and [the PR](https://x/Maya).", style), [], "code and link targets are left alone");
  assert.equal(styleProblems("body", "See [Maya's PR](https://x/1).", style).length, 1, "link text is prose");
  assert.deepEqual(styleProblems("body", "Mayan calendars aside.", style), [], "whole words only");
});

test("an honorific follows only its own member's tag", () => {
  assert.deepEqual(styleProblems("body", "@sam ji, can you approve the infra side?", style), []);
  assert.match(styleProblems("body", "@maya ji, can you check?", style)[0], /"ji" belongs only after @sam, not @maya/);
});

test("every posted piece is checked", () => {
  const p = { body: "Fine.", comments: [{ path: "a.js", line: 3, body: "Maya — look." }], _thread_replies: [{ in_reply_to: 1, body: "Done – thanks." }] };
  const out = payloadStyleProblems(p, style);
  assert.ok(out.some((x) => x.startsWith("comment a.js:3: has an em")));
  assert.ok(out.some((x) => x.startsWith("comment a.js:3: names Maya")));
  assert.ok(out.some((x) => x.startsWith("reply to 1: has an em")));
});
