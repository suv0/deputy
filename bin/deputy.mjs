#!/usr/bin/env node
// deputy: a stand-in reviewer that reviews pull requests when your review is requested.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { askUser } from "../src/ask.mjs";
import { cleanup, prepare, record } from "../src/checkout.mjs";
import { defaultStateDir, loadConfig, paths as pathsOf, ROOT } from "../src/config.mjs";
import { checkConfig, loadJobs } from "../src/jobs.mjs";
import { makeGh } from "../src/github.mjs";
import { askModel, readUsage, sinceOf, usageSummary } from "../src/models.mjs";
import { notify } from "../src/notify.mjs";
import { findPending } from "../src/pending.mjs";
import { dropHeld, listHeld, postReview } from "../src/post.mjs";
import { isAlive, statusReport, describeStatus } from "../src/status.mjs";
import { SOFTEN_PREFIX } from "../src/verdict.mjs";
import { parseArgs, readJson, run, writeJson } from "../src/util.mjs";
import { claimPidFile, lockHeld, watch } from "../src/watcher.mjs";

const HELP = `deputy: background agent jobs that wake only when there is work. Built in: PR review.

Setup
  deputy init                 write a starter config to ~/.deputy/config.json
  deputy doctor               check gh, the driver, the model tools and the config
  deputy demo [--fast] [--no-popup] [--draft]   one whole review with no GitHub and no model

Running
  deputy start                run every job's check on its timer (foreground; see the README for logon)
  deputy once                 check every job once, and run the ones with work
  deputy jobs                 the configured jobs
  deputy check <job>          run one job's check and print what it found (no agent run)
  deputy status [--line]      is it alive, and what is it doing
  deputy pending              the PRs that wait on you, as JSON
  deputy held                 reviews held for you;  held post|soften|drop <k>

Used by agent runs (any job)
  deputy prepare <owner/repo> <n>         fresh checkout and run folder (JSON)
  deputy model --tier <legwork|review|challenge> --prompt-file <f> [--out <f>] [--cwd <dir>] [--label <text>]
  deputy post <review.json> [--post]      check a review, then post or hold it
  deputy record <job> <id> <version> [outcome]   mark an item handled at this version
  deputy cleanup <owner/repo> <n>
  deputy ask "<question>"                 the answer window: yes / no / your words
  deputy notify "<title>" "<body>"
  deputy usage [--since 24h] [--line]

Options: --config <file> (or $DEPUTY_CONFIG); state lives in ~/.deputy (or $DEPUTY_HOME).`;

const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;

function load({ strict = true } = {}) {
  const config = loadConfig(args.config);
  const problems = checkConfig(config);
  if (strict && problems.length) {
    console.error(`deputy: the config ${config.file ?? "(none found)"} is not ready:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("Run `deputy init`, then edit the file.");
    process.exit(2);
  }
  return { config, paths: pathsOf(config) };
}

function need(value, usage) {
  if (value === undefined || value === true || value === "") { console.error(`usage: ${usage}`); process.exit(2); }
  return value;
}

const commands = {
  async help() { console.log(HELP); },

  async init() {
    const target = args.here ? resolve("deputy.config.json") : join(defaultStateDir(), "config.json");
    if (existsSync(target) && !args.force) { console.log(`${target} already exists (--force to replace it).`); return; }
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(join(ROOT, "examples", "deputy.config.example.json"), target);
    console.log(`Wrote ${target}.\nSet github.login and repos, then run: deputy doctor`);
  },

  async doctor() {
    const { config } = load({ strict: false });
    const ok = (good, text) => console.log(`${good ? "✔" : "✘"} ${text}`);
    ok(Boolean(config.file), `config: ${config.file ?? "none found (deputy init)"}`);
    for (const p of checkConfig(config)) ok(false, p);
    ok(Number(process.versions.node.split(".")[0]) >= 20, `Node ${process.versions.node} (20 or newer)`);
    const gh = await run("gh", ["auth", "status"], { timeoutMs: 30_000 });
    ok(gh.code === 0, gh.code === 0 ? "gh is installed and logged in" : "gh is missing or not logged in (gh auth login)");
    if (gh.code === 0 && config.github.login) {
      const who = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 30_000 });
      const me = who.stdout.trim();
      ok(me.toLowerCase() === config.github.login.toLowerCase(), `gh is logged in as ${me || "?"}; config says ${config.github.login}`);
    }
    const driver = await run(config.driver.command, ["--version"], { timeoutMs: 30_000 });
    ok(driver.code === 0, `driver: ${config.driver.command} ${driver.code === 0 ? driver.stdout.trim().split("\n")[0] : "not found"}`);
    const tools = new Set(Object.values(config.models.tiers).flat().map((c) => c.tool));
    for (const t of tools) {
      const command = config.models.tools?.[t] ?? t;
      const r = await run(command, ["--version"], { timeoutMs: 30_000 });
      ok(r.code === 0, `model tool ${t}: ${r.code === 0 ? r.stdout.trim().split("\n")[0] : `"${command}" not found`}`);
    }
    for (const k of ["checklist", "reviewerRules", "teamFile", "voiceFile", "docsDir"]) {
      const p = config.context[k];
      if (p) ok(existsSync(p), `${k}: ${p}`);
    }
    console.log(`posting: ${config.posting}${config.posting === "draft" ? " (reviews are held for you; set \"auto\" to post)" : " (reviews that pass every check are POSTED)"}`);
  },

  async demo() {
    const { demo } = await import("../src/demo.mjs");
    await demo({ fast: Boolean(args.fast), popup: !args["no-popup"], draft: Boolean(args.draft) });
  },

  async start() {
    const { config, paths } = load();
    mkdirSync(paths.state, { recursive: true });
    const other = claimPidFile(paths.pid);
    if (other) { console.log(`deputy is already watching (pid ${other}).`); return; }
    process.on("exit", () => {
      try { if (readFileSync(paths.pid, "utf8") === String(process.pid)) rmSync(paths.pid); } catch {}
      try { writeJson(paths.status, { ...readJson(paths.status, {}), state: "stopped", stoppedAt: new Date().toISOString() }); } catch {}
    });
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
    console.log(`deputy: running ${loadJobs(config).map((j) => `${j.name} (every ${j.everyMinutes} min)`).join(", ")}; posting: ${config.posting}. Ctrl+C stops it.`);
    await watch({ config, paths, gh: makeGh(), notify: (t, b) => notify(t, b, { enabled: config.notify }) });
  },

  async once() {
    const { config, paths } = load();
    await watch({ config, paths, gh: makeGh(), notify: (t, b) => notify(t, b, { enabled: config.notify }), once: true });
    console.log(describeStatus(readJson(paths.status, null), { alive: true, held: listHeld(paths.held).length }));
  },

  async status() {
    const { paths } = load({ strict: false });
    const s = readJson(paths.status, null);
    const held = listHeld(paths.held).length;
    const lines = statusReport(s, { alive: isAlive(s?.pid), held, runsDir: paths.runs });
    console.log(args.line ? lines[0] : lines.join("\n"));
  },

  async pending() {
    const { config, paths } = load();
    if (!args.run && lockHeld(paths.lock, config.runLimitMinutes * 60_000)) { console.log("[]"); return; }
    console.log(JSON.stringify(await findPending({ config, gh: makeGh(), done: readJson(paths.done, {}) }), null, 2));
  },

  async prepare() {
    const { config, paths } = load();
    const repo = need(rest[0], "deputy prepare <owner/repo> <n>");
    const n = Number(need(rest[1], "deputy prepare <owner/repo> <n>"));
    console.log(JSON.stringify(await prepare({ config, paths, gh: makeGh(), repo, n }), null, 2));
  },

  async cleanup() {
    const { config } = load();
    console.log(`removed ${await cleanup({ config, repo: need(rest[0], "deputy cleanup <owner/repo> <n>"), n: Number(rest[1]) })}`);
  },

  async record() {
    const { paths } = load();
    const usage = "deputy record <job> <id> <version> [outcome]";
    record(paths.done, { job: need(rest[0], usage), id: need(rest[1], usage), version: need(rest[2], usage), outcome: rest.slice(3).join(" ") || "handled" });
    console.log(`recorded ${rest[0]} ${rest[1]} at ${String(rest[2]).slice(0, 12)}`);
  },

  async jobs() {
    const { config } = load({ strict: false });
    for (const j of config.jobs) console.log(`${j.enabled === false ? "(off) " : ""}${j.name}: ${j.builtin ? `built-in ${j.builtin}` : `check ${j.check?.join(" ")}, prompt ${j.prompt}`}, every ${j.everyMinutes ?? config.pollMinutes} min`);
  },

  async check() {
    const { config, paths } = load();
    const job = loadJobs(config).find((j) => j.name === need(rest[0], "deputy check <job>"));
    if (!job) { console.error(`No job named ${rest[0]}. deputy jobs lists them.`); process.exit(2); }
    const items = await job.check({ gh: makeGh(), done: readJson(paths.done, {}), paths, config });
    console.log(JSON.stringify(items, null, 2));
    console.error(`${items.length} item${items.length === 1 ? "" : "s"} need work; a run would take ${Math.min(items.length, job.maxItemsPerRun)}.`);
  },

  async model() {
    const { config, paths } = load({ strict: false });
    const prompt = args.prompt ?? (args["prompt-file"] ? readFileSync(args["prompt-file"], "utf8") : null);
    if (!prompt?.trim()) { console.error("deputy model: pass --prompt or --prompt-file"); process.exit(2); }
    const r = await askModel({
      config, paths, prompt, tier: args.tier, tool: args.tool, model: args.model, effort: args.effort,
      cwd: resolve(args.cwd ?? "."), mode: args.mode ?? "read", label: args.label ?? null,
      timeoutSeconds: Number(args.timeout ?? 900), maxTurns: Number(args["max-turns"] ?? 60),
    });
    if (!r.ok) {
      console.error(`deputy model: every model failed:\n${r.attempts.map((a) => `  ${a.tool} ${a.model}: ${a.error}`).join("\n") || "  (none was available)"}`);
      process.exitCode = 1;
      return;
    }
    if (args.out) { const { writeFileSync } = await import("node:fs"); writeFileSync(args.out, r.text); }
    process.stdout.write(r.text);
  },

  async usage() {
    const { paths } = load({ strict: false });
    const s = usageSummary(readUsage(paths.usage), sinceOf(args.since === true ? undefined : args.since));
    if (args.line) { console.log(s.line); return; }
    console.log(`${s.runs} model runs. ${s.line}`);
    for (const e of s.recent.slice(-15).reverse()) console.log(`  ${e.at.slice(0, 16)} ${e.model}${e.label ? ` [${e.label}]` : ""}: ${e.ok ? e.did ?? "" : `failed: ${e.error}`}`);
  },

  async post() {
    const { config, paths } = load();
    const file = need(rest[0], "deputy post <review.json> [--post]");
    const r = await postReview({ file: resolve(file), config, paths, gh: makeGh(), doPost: Boolean(args.post) });
    console.log(r.lines.join("\n"));
    if (r.outcome === "invalid") process.exitCode = 1;
  },

  async held() {
    const { config, paths } = load();
    const items = listHeld(paths.held);
    const [sub, k] = rest;
    if (!sub || sub === "list") {
      if (!items.length) { console.log("No reviews held for you."); return; }
      items.forEach((h, i) => {
        console.log(`${i + 1}. ${h.repo} #${h.number}${h.title ? `: ${h.title}` : ""}`);
        if (h.url) console.log(`   ${h.url}`);
        console.log(`   held because: ${h.why}`);
        console.log(`   draft: ${h.draft.event}, ${h.draft.comments?.length ?? 0} inline comments, head ${h.head.slice(0, 9)}, held ${h.at}`);
        console.log(`   ${h.draft.body.split("\n").slice(0, 6).join("\n   ")}`);
      });
      console.log("\ndeputy held post <k> | soften <k> | drop <k>");
      return;
    }
    const h = items[Number(k) - 1];
    if (!h) { console.error(`No held review ${k}. Run deputy held to list them.`); process.exit(1); }
    if (sub === "drop") { dropHeld(h); console.log(`Dropped ${h.repo} #${h.number}; nothing posted.`); return; }
    if (sub !== "post" && sub !== "soften") { console.error(`Unknown: deputy held ${sub}`); process.exit(2); }
    // Posting a held review is a person's decision, so it needs a person at a terminal.
    if (!process.stdin.isTTY && !args.yes) { console.error("deputy held post/soften runs from a terminal (or add --yes)."); process.exit(2); }
    const draft = structuredClone(h.draft);
    if (sub === "soften" && draft.event === "REQUEST_CHANGES") { draft.event = "APPROVE"; draft.body = SOFTEN_PREFIX + draft.body; }
    const dir = join(paths.runs, `held-${h.name}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `review-${h.number}.json`);
    writeJson(file, draft);
    const policyFree = { ...config, verdict: { ...config.verdict, requestChanges: "allow" } };
    const r = await postReview({ file, config: policyFree, paths, gh: makeGh(), doPost: true, force: true });
    console.log(r.lines.join("\n"));
    if (r.outcome === "posted") dropHeld(h);
    else { console.error("Not posted. If the PR moved to a new head, drop this one: deputy reviews the new head by itself."); process.exitCode = 1; }
  },

  async ask() {
    const { config } = load({ strict: false });
    const q = need(rest.join(" "), 'deputy ask "<question>"');
    console.log(JSON.stringify(await askUser(q, { minutes: Number(args.minutes ?? config.ask.minutes), remindEveryMinutes: config.ask.remindEveryMinutes })));
  },

  async notify() {
    notify(need(rest[0], 'deputy notify "<title>" "<body>"'), rest[1] ?? "");
  },
};

const fn = commands[cmd ?? "help"] ?? (args.help ? commands.help : null);
if (!fn || args.help) { console.log(HELP); process.exit(fn || args.help ? 0 : 2); }
try {
  await fn();
} catch (error) {
  console.error(`deputy ${cmd}: ${error.message ?? error}`);
  process.exitCode = 1;
}
