// `deputy post <review.json> [--post]`: check a drafted review against GitHub, then post it,
// hold it for you, or refuse it.
//
// Checks, every time: the shape, the PR head hasn't moved, the docs tip hasn't moved (when a
// docs folder is set up), every inline comment sits inside GitHub's diff, every thread reply
// answers a top-level comment of the PR. Then the verdict policy. Only with --post, and only when
// `posting` is "auto", does anything reach GitHub; in draft mode the review is held for you.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { checkAnchors } from "./anchors.mjs";
import { alertsIn, applyVerdictPolicy, checkShape, verdictLabel } from "./verdict.mjs";
import { payloadStyleProblems } from "./style.mjs";
import { readJson, run, writeJson } from "./util.mjs";

export async function docsTip(docsDir) {
  const r = await run("git", ["-C", docsDir, "ls-remote", "origin", "HEAD"], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ls-remote in ${docsDir} failed`);
  return r.stdout.slice(0, 7);
}

/** Every check that doesn't change anything. Returns { problems, notes, policy, files }. */
export async function checkReview({ payload, gh, config, runDir = null, getDocsTip = docsTip }) {
  const problems = checkShape(payload);
  const notes = [];
  if (problems.length) return { problems, notes, policy: null };
  const repo = payload._repo, n = payload._number;

  // The text first: it reads like a teammate typed it, or it doesn't leave.
  problems.push(...payloadStyleProblems(payload, config.style));

  const pr = await gh.json(["pr", "view", String(n), "-R", repo, "--json", "headRefOid,state,isDraft"]);
  if (pr.headRefOid !== payload.commit_id) problems.push(`head moved: now ${pr.headRefOid.slice(0, 9)}, review is for ${payload.commit_id.slice(0, 9)}`);
  if (pr.state !== "OPEN") problems.push(`the PR is ${pr.state.toLowerCase()}`);

  if (config.context.docsDir && config.context.refreshDocs && payload._docs_commit) {
    const tip = await getDocsTip(config.context.docsDir);
    if (tip !== String(payload._docs_commit).slice(0, 7)) problems.push(`docs moved to ${tip} since the review read them at ${payload._docs_commit}`);
  }

  const files = (await gh.json(["api", `repos/${repo}/pulls/${n}/files`, "--paginate", "--slurp"])).flat();
  problems.push(...checkAnchors(files, payload.comments ?? []));

  const replies = payload._thread_replies ?? [];
  if (replies.length) {
    const comments = (await gh.json(["api", `repos/${repo}/pulls/${n}/comments`, "--paginate", "--slurp"])).flat();
    const top = new Set(comments.filter((c) => !c.in_reply_to_id).map((c) => c.id));
    for (const r of replies) if (!top.has(r.in_reply_to)) problems.push(`reply target ${r.in_reply_to} is not a top-level comment on this PR`);
  }

  // Important work needs the challenge before it leaves, whatever the run decided.
  const why = importantBecause({ files, payload, important: config.important });
  if (why && runDir && config.requireChallenge !== false && !existsSync(join(runDir, "challenge.md")))
    problems.push(`important work (${why}): run the challenge tier into ${join(runDir, "challenge.md")} before posting`);

  const policy = applyVerdictPolicy(payload, config.verdict);
  notes.push(...policy.notes);
  return { problems, notes, policy };
}

/** A glob like `**\/migrations/**` or `*.tf` as a regular expression over a forward-slash path. Pure. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Why a review counts as important work, or null. Pure. */
export function importantBecause({ files = [], payload, important = {} }) {
  if (payload.event === "REQUEST_CHANGES") return "it requests changes";
  if (alertsIn(payload.body).caution) return "it holds the merge";
  const globs = (important.paths ?? []).map(globToRegExp);
  const hit = files.map((f) => f.filename).find((f) => globs.some((g) => g.test(f)));
  return hit ? `it changes ${hit}` : null;
}

export function heldName(payload) {
  return `${payload._repo.replace("/", "-")}-${payload._number}.json`;
}

export function holdReview({ dir, payload, why, title, url }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, heldName(payload));
  writeJson(file, { repo: payload._repo, number: payload._number, title: title ?? null, url: url ?? null, head: payload.commit_id, why, at: new Date().toISOString(), draft: payload });
  return file;
}

/** Submit the review, read it back, then post the thread replies. */
export async function submitReview({ payload, gh, workDir }) {
  const repo = payload._repo, n = payload._number;
  const out = { commit_id: payload.commit_id, event: payload.event, body: payload.body, comments: payload.comments ?? [] };
  const sendFile = join(workDir, `send-${n}.json`);
  writeFileSync(sendFile, JSON.stringify(out));
  const posted = await gh.json(["api", "-X", "POST", `repos/${repo}/pulls/${n}/reviews`, "--input", sendFile]);
  const back = (await gh.json(["api", `repos/${repo}/pulls/${n}/reviews/${posted.id}/comments`, "--paginate", "--slurp"])).flat();
  const lines = [`POSTED review ${posted.id} (${posted.state}) ${posted.html_url ?? ""}`.trim(),
    `read back: ${back.length}/${out.comments.length} inline comments`];
  for (const r of payload._thread_replies ?? []) {
    const made = await gh.json(["api", "-X", "POST", `repos/${repo}/pulls/${n}/comments/${r.in_reply_to}/replies`, "--raw-field", `body=${r.body}`]);
    lines.push(`thread reply ${made.id} -> ${r.in_reply_to}`);
  }
  return { posted, lines };
}

/**
 * The whole `deputy post` step. `force` is set only by a person posting a held review.
 * @returns { outcome: "invalid"|"checked"|"held"|"posted", lines: string[] }
 */
export async function postReview({ file, config, paths, gh, doPost = false, force = false, getDocsTip }) {
  const payload = JSON.parse(readFileSync(file, "utf8"));
  const lines = [];
  const { problems, notes, policy } = await checkReview({ payload, gh, config, getDocsTip, runDir: force ? null : dirname(file) });
  lines.push(`${payload._repo ?? "?"} PR ${payload._number ?? "?"}: ${payload.event} with ${payload.comments?.length ?? 0} inline comments`);
  for (const n of notes) lines.push(`  note: ${n}`);
  if (problems.length) {
    for (const p of problems) lines.push(`  - ${p}`);
    lines.push("  NOT POSTED: fix the review file and run this again");
    return { outcome: "invalid", lines };
  }
  if (!doPost) { lines.push(`  checks pass (dry run); would post: ${verdictLabel(policy.payload)}`); return { outcome: "checked", lines }; }

  const why = policy.hold ?? (config.posting !== "auto" && !force ? "draft mode: posting is \"draft\" in the config" : null);
  if (why && !force) {
    const where = holdReview({ dir: paths.held, payload: policy.payload, why, title: payload._title, url: payload._url });
    writeFileSync(join(dirname(file), `held-${payload._number}`), `${why}\n`);
    lines.push(`  HELD for you (${why}): ${where}`, "  see it with `deputy held`, post it with `deputy held post <k>`");
    return { outcome: "held", lines };
  }
  const { lines: sent } = await submitReview({ payload: policy.payload, gh, workDir: dirname(file) });
  lines.push(...sent.map((l) => `  ${l}`));
  return { outcome: "posted", lines };
}

/** Held reviews, oldest first, numbered from 1 in `deputy held`. */
export function listHeld(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => ({ file: join(dir, f), name: basename(f, ".json"), ...readJson(join(dir, f), {}) }));
}

export function dropHeld(item) {
  rmSync(item.file, { force: true });
}
