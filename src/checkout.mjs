// `deputy prepare <owner/repo> <n>`, `deputy cleanup <owner/repo> <n>`, `deputy record ...`:
// the review run's own checkout, run folder and bookkeeping, so the prompt never improvises git.
import { existsSync, mkdirSync, renameSync } from "node:fs";
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
  return { repo, number: n, head, base: pr.baseRefName, checkout: tree, runDir, docsCommit: await docsCommit(config) };
}

export async function cleanup({ config, repo, n }) {
  const clone = clonePath(config, repo);
  const tree = worktreePath(config, repo, n);
  if (existsSync(tree)) await git(["worktree", "remove", "--force", tree], clone);
  await run("git", ["branch", "-D", `deputy-pr-${n}`], { cwd: clone });
  return tree;
}

/** Mark an item handled at a version (a PR at its head), so its job skips it until the version changes. */
export function record(donePath, { job, id, version, outcome }) {
  const done = readJson(donePath, {});
  done[`${job}:${id}`] = { version, outcome: outcome ?? "handled", at: new Date().toISOString() };
  writeJson(donePath, done);
}
