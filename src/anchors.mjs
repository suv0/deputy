// Inline review comments must sit on lines GitHub shows in the PR's diff, or the whole review
// is refused. These checks read GitHub's own patches (the files API), not a local `git diff`,
// which can show a moved file as new.

/** Parse one file's unified-diff patch into hunks, each with the line numbers it shows per side. */
export function parseHunks(patch) {
  const hunks = [];
  let cur = null, left = 0, right = 0;
  const lines = (patch ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop(); // a trailing newline is not one more context line
  for (const line of lines) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      left = Number(h[1]); right = Number(h[2]);
      cur = { LEFT: new Set(), RIGHT: new Set() };
      hunks.push(cur);
      continue;
    }
    if (!cur || line.startsWith("\\")) continue; // "\ No newline at end of file" is not a line
    if (line.startsWith("+")) cur.RIGHT.add(right++);
    else if (line.startsWith("-")) cur.LEFT.add(left++);
    else { cur.RIGHT.add(right++); cur.LEFT.add(left++); }
  }
  return hunks;
}

/**
 * Check every inline comment of a review payload against the PR's files.
 * @param files   rows from GET /repos/{o}/{r}/pulls/{n}/files ({ filename, patch })
 * @param comments payload.comments ({ path, line, side?, start_line?, start_side? })
 * @returns a list of problems, empty when every anchor is valid
 */
export function checkAnchors(files, comments = []) {
  const byPath = new Map(files.map((f) => [f.filename, f]));
  const problems = [];
  for (const c of comments) {
    const where = `${c.path}:${c.start_line ? `${c.start_line}-` : ""}${c.line}`;
    const f = byPath.get(c.path);
    if (!f) { problems.push(`${c.path} is not in the PR's diff`); continue; }
    if (!f.patch) { problems.push(`${c.path} has no patch GitHub can show (binary or too large); move the comment into the body`); continue; }
    if (!Number.isInteger(c.line)) { problems.push(`${where}: an inline comment needs a whole-number line`); continue; }
    const side = c.side ?? "RIGHT";
    const startSide = c.start_side ?? side;
    if (!["LEFT", "RIGHT"].includes(side) || !["LEFT", "RIGHT"].includes(startSide)) { problems.push(`${where}: side must be LEFT or RIGHT`); continue; }
    const hunks = parseHunks(f.patch);
    const endHunk = hunks.findIndex((h) => h[side].has(c.line));
    if (endHunk < 0) { problems.push(`${where} (${side}) is outside every hunk`); continue; }
    if (c.start_line != null) {
      const startHunk = hunks.findIndex((h) => h[startSide].has(c.start_line));
      if (startHunk < 0) problems.push(`${where}: start line ${c.start_line} (${startSide}) is outside every hunk`);
      else if (startHunk !== endHunk) problems.push(`${where}: start and end lines are in different hunks`);
      else if (startSide === side && c.start_line > c.line) problems.push(`${where}: start line comes after the end line`);
    }
  }
  return problems;
}
