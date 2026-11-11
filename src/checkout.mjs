// `deputy prepare <owner/repo> <n>`, `deputy cleanup <owner/repo> <n>`, `deputy record ...`:
// the review run's own checkout, run folder and bookkeeping, so the prompt never improvises git.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDirName } from "./status.mjs";
import { readJson, run, writeJson } from "./util.mjs";

async function git(args, cwd) {
  const r = await run("git", args, { cwd, timeoutMs: 15 * 60_000 });
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  return r.stdout.trim();
}

export function clonePath(config, repo) {
  return config.checkouts.clones?.[repo] ?? join(config.checkouts.root, repo.replace("/", "-"));
}

export function worktreePath(config, repo, n) {
  return join(config.checkouts.root, `${repo.replace("/", "-")}-pr-${n}`);
}

/** Bring the docs copy to its remote tip (only when refreshDocs is on; it resets that folder). */
export async function docsCommit(config) {
  const dir = config.context.docsDir;
  if (!dir || !existsSync(join(dir, ".git"))) return null;
  if (config.context.refreshDocs) {
    const tip = (await git(["ls-remote", "origin", "HEAD"], dir)).split(/\s/)[0];
    await git(["fetch", "-q", "origin"], dir);
    await git(["checkout", "-q", "--detach", "--force", tip], dir);
    await git(["clean", "-fdxq"], dir);
  }
  return git(["rev-parse", "--short=7", "HEAD"], dir);
}

export async function prepare({ config, paths, gh, repo, n }) {
  const pr = await gh.json(["pr", "view", String(n), "-R", repo, "--json", "headRefOid,baseRefName"]);
  const clone = clonePath(config, repo);
  if (!existsSync(join(clone, ".git"))) {
    mkdirSync(config.checkouts.root, { recursive: true });
    await gh.text(["repo", "clone", repo, clone, "--", "--filter=blob:none", "--quiet"]);
  }
  const branch = `deputy-pr-${n}`;
  await git(["fetch", "-q", "--force", "origin", pr.baseRefName, `+pull/${n}/head:${branch}`], clone);
  const tree = worktreePath(config, repo, n);
  if (existsSync(tree)) await git(["worktree", "remove", "--force", tree], clone);
  await git(["worktree", "prune"], clone);
  await git(["worktree", "add", "-q", "--detach", tree, branch], clone);
  const head = await git(["rev-parse", "HEAD"], tree);

  const runDir = join(paths.runs, runDirName(repo, n));
  if (existsSync(runDir)) renameSync(runDir, `${runDir}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(runDir, { recursive: true });
  // GitHub facts are collected here, not by a model: model sandboxes often have no network.
  const githubFacts = join(runDir, "github.md");
  writeFileSync(githubFacts, formatGithubFacts(await collectGithubFacts({ gh, repo, n })));
  return { repo, number: n, head, base: pr.baseRefName, checkout: tree, runDir, githubFacts, docsCommit: await docsCommit(config) };
}

const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: String(e.message ?? e).split("\n")[0] }; } };

/** Everything about the PR that lives on GitHub: description, threads, checks, failing logs, overlapping PRs. */
export async function collectGithubFacts({ gh, repo, n, logLines = 60 }) {
  const pr = await attempt(() => gh.json(["pr", "view", String(n), "-R", repo, "--json", "title,body,author,url,baseRefName,headRefOid,labels,files,reviews,comments,statusCheckRollup,closingIssuesReferences"]));
  const inline = await attempt(async () => (await gh.json(["api", `repos/${repo}/pulls/${n}/comments`, "--paginate", "--slurp"])).flat());
  const open = await attempt(() => gh.json(["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", "number,title,author,files"]));
  const failed = pr.ok ? (pr.value.statusCheckRollup ?? []).filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(c.conclusion ?? c.state)) : [];
  const logs = [];
  for (const c of failed.slice(0, 3)) {
    const runId = String(c.detailsUrl ?? "").match(/actions\/runs\/(\d+)/)?.[1];
    if (!runId) continue;
    const log = await attempt(() => gh.text(["run", "view", runId, "-R", repo, "--log-failed"]));
    logs.push({ name: c.name ?? c.context, runId, ...(log.ok ? { tail: log.value.trimEnd().split("\n").slice(-logLines).join("\n") } : { error: log.error }) });
  }
  return { repo, n, pr, inline, open, logs };
}

const clip = (s, max = 600) => { const t = String(s ?? "").trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };

/** The facts as markdown a model can read without network. Pure. */
export function formatGithubFacts({ repo, n, pr, inline, open, logs = [] }) {
  const out = [`# GitHub facts for ${repo} #${n}`, "", "Collected by deputy. Anything marked unknown could not be read."];
  if (!pr.ok) return [...out, "", `PR: unknown (${pr.error})`].join("\n") + "\n";
  const p = pr.value;
  out.push("", `## ${p.title}`, `${p.url} by ${p.author?.login ?? "?"}, into ${p.baseRefName}, head ${p.headRefOid}`);
  if (p.labels?.length) out.push(`Labels: ${p.labels.map((l) => l.name).join(", ")}`);
  if (p.closingIssuesReferences?.length) out.push(`Closes: ${p.closingIssuesReferences.map((i) => `#${i.number}`).join(", ")}`);
  out.push("", "### Description", "", clip(p.body, 4000) || "(empty)");
  out.push("", "### Files", "", ...(p.files ?? []).map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`));
  out.push("", "### Reviews", "");
  for (const r of p.reviews ?? []) out.push(`- ${r.author?.login ?? "?"} ${r.state} at ${String(r.commit?.oid ?? "").slice(0, 9)}: ${clip(r.body, 800) || "(no body)"}`);
  if (!p.reviews?.length) out.push("(none)");
  out.push("", "### Conversation", "");
  for (const c of p.comments ?? []) out.push(`- ${c.author?.login ?? "?"}: ${clip(c.body)}`);
  if (!p.comments?.length) out.push("(none)");
  out.push("", "### Inline threads", "");
  if (!inline.ok) out.push(`unknown (${inline.error})`);
  else if (!inline.value.length) out.push("(none)");
  else for (const c of inline.value) out.push(`- id ${c.id}${c.in_reply_to_id ? ` reply to ${c.in_reply_to_id}` : ""}, ${c.user?.login ?? "?"} on ${c.path}:${c.line ?? c.original_line ?? "?"}: ${clip(c.body, 500)}`);
  out.push("", "### Checks", "");
  for (const c of p.statusCheckRollup ?? []) out.push(`- ${c.name ?? c.context}: ${c.conclusion || c.state || c.status}`);
  if (!p.statusCheckRollup?.length) out.push("(none)");
  for (const l of logs) out.push("", `### Failing log: ${l.name} (run ${l.runId})`, "", ...(l.tail ? ["```text", l.tail, "```"] : [`unknown (${l.error})`]));
  out.push("", "### Other open PRs touching the same files", "");
  if (!open.ok) out.push(`unknown (${open.error})`);
  else {
    const mine = new Set((p.files ?? []).map((f) => f.path));
    const hits = open.value.filter((o) => o.number !== n).map((o) => ({ ...o, shared: (o.files ?? []).map((f) => f.path).filter((f) => mine.has(f)) })).filter((o) => o.shared.length);
    if (!hits.length) out.push("(none)");
    for (const o of hits) out.push(`- #${o.number} ${o.title} (${o.author?.login ?? "?"}): ${o.shared.slice(0, 5).join(", ")}${o.shared.length > 5 ? ` and ${o.shared.length - 5} more` : ""}`);
  }
  return out.join("\n") + "\n";
}

/** Remove a PR's checkout and branch. Safe to run twice; a folder git won't remove is deleted. */
export async function cleanup({ config, repo, n }) {
  const clone = clonePath(config, repo);
  const tree = worktreePath(config, repo, n);
  if (existsSync(tree)) {
    const r = await run("git", ["worktree", "remove", "--force", tree], { cwd: clone });
    if (r.code !== 0 && existsSync(tree)) rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  if (existsSync(join(clone, ".git"))) {
    await run("git", ["worktree", "prune"], { cwd: clone });
    await run("git", ["branch", "-D", `deputy-pr-${n}`], { cwd: clone });
  }
  return tree;
}

/** Mark an item handled at a version (a PR at its head), so its job skips it until the version changes. */
export function record(donePath, { job, id, version, outcome }) {
  const done = readJson(donePath, {});
  done[`${job}:${id}`] = { version, outcome: outcome ?? "handled", at: new Date().toISOString() };
  writeJson(donePath, done);
}
