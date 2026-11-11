import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAnchors, parseHunks } from "../src/anchors.mjs";

const PATCH = [
  "@@ -10,4 +10,5 @@ function a() {",
  " ctx10",
  "-old11",
  "+new11",
  "+new12",
  " ctx13",
  " ctx14",
  "@@ -40,2 +41,3 @@ function b() {",
  " ctx41",
  "+new42",
  " ctx43",
  "\\ No newline at end of file",
].join("\n");

const files = [{ filename: "src/a.js", patch: PATCH }, { filename: "logo.png" }];

test("parseHunks numbers both sides and ignores the no-newline marker", () => {
  const [h1, h2] = parseHunks(PATCH);
  assert.deepEqual([...h1.RIGHT], [10, 11, 12, 13, 14]);
  assert.deepEqual([...h1.LEFT], [10, 11, 12, 13]);
  assert.deepEqual([...h2.RIGHT], [41, 42, 43]);
  assert.deepEqual([...h2.LEFT], [40, 41]);
});

test("a trailing newline is not an extra line", () => {
  const [h] = parseHunks("@@ -1,1 +1,1 @@\n-a\n+b\n");
  assert.deepEqual([...h.RIGHT], [1]);
  assert.deepEqual([...h.LEFT], [1]);
});

test("comments on changed or shown lines pass", () => {
  assert.deepEqual(checkAnchors(files, [
    { path: "src/a.js", line: 12, side: "RIGHT", body: "x" },
    { path: "src/a.js", line: 13, body: "context lines count, RIGHT by default" },
    { path: "src/a.js", line: 11, side: "LEFT", body: "a removed line" },
    { path: "src/a.js", start_line: 11, line: 13, side: "RIGHT", body: "range" },
  ]), []);
});

test("lines outside every hunk, unknown files and binary files are caught", () => {
  const problems = checkAnchors(files, [
    { path: "src/a.js", line: 30, body: "between hunks" },
    { path: "src/a.js", line: 44, body: "the no-newline marker is not line 44" },
    { path: "src/b.js", line: 1, body: "not in the diff" },
    { path: "logo.png", line: 1, body: "binary" },
    { path: "src/a.js", line: 14, side: "LEFT", body: "LEFT side ends at 13" },
  ]);
  assert.equal(problems.length, 5);
  assert.match(problems[0], /outside every hunk/);
  assert.match(problems[2], /not in the PR's diff/);
  assert.match(problems[3], /no patch/);
});

test("a range must stay inside one hunk and run forwards", () => {
  const [cross] = checkAnchors(files, [{ path: "src/a.js", start_line: 12, line: 42, body: "x" }]);
  assert.match(cross, /different hunks/);
  const [backwards] = checkAnchors(files, [{ path: "src/a.js", start_line: 13, line: 11, body: "x" }]);
  assert.match(backwards, /after the end line/);
  const [startOut] = checkAnchors(files, [{ path: "src/a.js", start_line: 2, line: 11, body: "x" }]);
  assert.match(startOut, /start line 2/);
});

test("a missing or fractional line is refused", () => {
  assert.match(checkAnchors(files, [{ path: "src/a.js", body: "x" }])[0], /whole-number line/);
  assert.match(checkAnchors(files, [{ path: "src/a.js", line: 11.5, body: "x" }])[0], /whole-number line/);
});
