// Loading and checking deputy's one config file.
//
// Where it looks, first match wins: --config <file>, $DEPUTY_CONFIG, ./deputy.config.json,
// then <state dir>/config.json (~/.deputy/config.json unless $DEPUTY_HOME says otherwise).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEPUTY_BIN = join(ROOT, "bin", "deputy.mjs");

export const DEFAULTS = {
  // Each job is a cheap check on a timer plus a prompt for the agent run. "pr-review" is built in;
  // add your own as { "name", "check": ["node", "check.mjs"], "prompt": "prompt.md", "everyMinutes" }.
  jobs: [{ name: "pr-review", builtin: "pr-review" }],
  // Settings of the pr-review job.
  github: { login: "", teams: [] },
  repos: [],
  pollMinutes: 5,
  maxPrsPerRun: 4,
  runLimitMinutes: 120,
  // "draft": reviews are written and held for you; nothing reaches GitHub until you post it.
  // "auto": reviews that pass every check are posted. Opt in only once you trust the drafts.
  posting: "draft",
  skipApprovedByOthers: true,
  verdict: {
    // What an approving review is sent as. "COMMENT" if your team doesn't want bot approvals to count.
    approveEvent: "APPROVE",
    // A REQUEST_CHANGES draft: "allow" (the challenge must have failed to disprove it first; deputy
    // post enforces that), "soften" into an approval with a red CAUTION, or "hold" it for you.
    requestChanges: "allow",
  },
  // What posted text must look like (see src/style.mjs). team maps a name to its GitHub login.
  style: { noDashes: true, maxSentences: 3, maxParagraphChars: 350, team: {} },
  smallPrLines: 150,
  // Important work (see important) can't be posted or held until the challenge tier has run.
  requireChallenge: true,
  important: {
    paths: ["**/migrations/**", "**/auth/**", "**/payments/**", "**/billing/**", "**/infra/**", ".github/workflows/**", "**/*.tf", "**/Dockerfile"],
    topics: ["money", "payments", "billing", "refunds", "login", "sessions", "permissions", "secrets", "security", "personal data", "database migrations", "deploys"],
  },
  context: {
    docsDir: "",
    refreshDocs: false,
    teamFile: "",
    voiceFile: "",
    checklist: "checklist/review-checklist.md",
    reviewerRules: "prompts/reviewer-rules.md",
    extraInstructions: "",
  },
  checkouts: { root: "~/deputy-checkouts", clones: {} },
  driver: {
    command: "claude",
    args: ["-p", "--output-format", "text", "--allowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  },
  models: {
    tools: { "command-code": "command-code", codex: "codex", opencode: "opencode", claude: "claude" },
    // Only these tools may judge: draft a review or try to disprove one. Legwork may run anywhere.
    judges: ["codex", "claude"],
    judgingTiers: ["review", "challenge"],
    tiers: {
      // Claude Code's model aliases, so a fresh install works with only `claude` on PATH.
      legwork: [{ tool: "claude", model: "haiku" }],
      review: [{ tool: "claude", model: "sonnet" }],
      challenge: [{ tool: "claude", model: "opus" }],
    },
  },
  notify: true,
  ask: { minutes: 10, remindEveryMinutes: 2 },
  stateDir: "",
};

export function expandHome(p) {
  if (!p) return p;
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(2)) : p;
}

export function defaultStateDir() {
  return expandHome(process.env.DEPUTY_HOME || "~/.deputy");
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge for plain objects; arrays and scalars from `over` replace those in `base`. */
export function merge(base, over) {
  if (!isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

/** The problems that would make the watcher do the wrong thing. Empty means usable. */
export function validate(c, { jobProblems = () => [], usesPrReview = () => true } = {}) {
  const problems = [...jobProblems(c)];
  if (usesPrReview(c)) {
    if (!c.github?.login || c.github.login === "your-github-login") problems.push("github.login is not set");
    if (!Array.isArray(c.repos) || !c.repos.length) problems.push("repos is empty: list the owner/name repos to watch");
    for (const r of c.repos ?? []) if (!/^[\w.-]+\/[\w.-]+$/.test(r)) problems.push(`repos: "${r}" is not owner/name`);
  }
  if (!["draft", "auto"].includes(c.posting)) problems.push(`posting must be "draft" or "auto", not "${c.posting}"`);
  if (!["APPROVE", "COMMENT"].includes(c.verdict?.approveEvent)) problems.push("verdict.approveEvent must be APPROVE or COMMENT");
  if (!["hold", "soften", "allow"].includes(c.verdict?.requestChanges)) problems.push("verdict.requestChanges must be hold, soften or allow");
  if (!(c.pollMinutes >= 1)) problems.push("pollMinutes must be at least 1");
  if (!(c.maxPrsPerRun >= 1)) problems.push("maxPrsPerRun must be at least 1");
  for (const name of ["legwork", "review", "challenge"])
    if (!Array.isArray(c.models?.tiers?.[name]) || !c.models.tiers[name].length) problems.push(`models.tiers.${name} needs at least one model`);
  return problems;
}

export function findConfigFile(explicit) {
  const candidates = [explicit, process.env.DEPUTY_CONFIG, resolve("deputy.config.json"), join(defaultStateDir(), "config.json")];
  return candidates.find((f) => f && existsSync(f)) ?? null;
}

/** Load, merge over the defaults, and resolve paths. Throws only on unreadable JSON. */
export function loadConfig(explicit) {
  const file = findConfigFile(explicit);
  const raw = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const c = merge(DEFAULTS, raw);
  c.file = file;
  const base = file ? dirname(file) : process.cwd();
  const resolvePath = (p, from = base) => (!p ? "" : isAbsolute(expandHome(p)) ? expandHome(p) : resolve(from, p));
  c.stateDir = resolvePath(c.stateDir) || defaultStateDir();
  c.checkouts.root = resolvePath(c.checkouts.root);
  for (const k of ["docsDir", "teamFile", "voiceFile"]) c.context[k] = resolvePath(c.context[k]);
  // The checklist and reviewer rules ship with deputy; a relative path that exists next to the
  // config wins, otherwise it is read from deputy's own folder.
  for (const k of ["checklist", "reviewerRules"]) {
    const p = c.context[k];
    const local = resolvePath(p);
    c.context[k] = !p ? "" : existsSync(local) ? local : resolvePath(p, ROOT);
  }
  return c;
}

export function paths(c) {
  const s = c.stateDir;
  return {
    state: s,
    status: join(s, "status.json"),
    done: join(s, "done.json"),
    lock: join(s, "running.lock"),
    pid: join(s, "watcher.pid"),
    guardPid: join(s, "guard.pid"),
    pause: join(s, "paused.json"),
    log: join(s, "watcher.log"),
    runs: join(s, "runs"),
    held: join(s, "held"),
    down: join(s, "models-down.json"),
    usage: join(s, "model-runs.jsonl"),
  };
}
