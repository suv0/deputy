// `deputy demo [--fast] [--no-popup] [--draft]`: one whole review, with no GitHub and no model.
//
// The watcher, the pending filter, the anchor check, the verdict rules and the posting step are
// deputy's real code. Only GitHub and the models are stand-ins: a fake `gh` that knows three PRs
// in an "acme/shop" repo, and a scripted review run that writes what the models would write.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, merge, paths as pathsOf } from "./config.mjs";
import { postReview } from "./post.mjs";
import { describeStatus, runDirName, stageOf } from "./status.mjs";
import { sleep } from "./util.mjs";
import { watch } from "./watcher.mjs";
import { loadJobs } from "./jobs.mjs";

const HEAD = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";
const PATCH = [
  "@@ -10,7 +10,12 @@ export function cartTotal(items, coupons) {",
  "   const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);",
  "-  const discount = coupons[0]?.amount ?? 0;",
  "+  // Coupons now stack.",
  "+  let discount = 0;",
  "+  for (const c of coupons) {",
  "+    discount += c.amount;",
  "+  }",
  "+  ",
  "   return subtotal - discount;",
  " }",
].join("\n");

/** A pretend GitHub CLI that answers the calls deputy makes, and records what gets posted. */
export function fakeGh(posted = []) {
  const prs = [
    { number: 42, title: "Let coupons stack at checkout", author: { login: "maya" }, headRefOid: HEAD, baseRefName: "main", isDraft: false, state: "OPEN", mergedAt: null, additions: 6, deletions: 1, reviewRequests: [{ login: "you" }], url: "https://github.com/acme/shop/pull/42" },
    { number: 43, title: "WIP: new search page", author: { login: "leo" }, headRefOid: "b".repeat(40), baseRefName: "main", isDraft: true, state: "OPEN", mergedAt: null, additions: 120, deletions: 4, reviewRequests: [{ login: "you" }], url: "https://github.com/acme/shop/pull/43" },
    { number: 44, title: "Bump the logger", author: { login: "sam" }, headRefOid: "c".repeat(40), baseRefName: "main", isDraft: false, state: "OPEN", mergedAt: null, additions: 2, deletions: 2, reviewRequests: [{ login: "someone-else" }], url: "https://github.com/acme/shop/pull/44" },
  ];
  const json = async (args) => {
    const a = args.join(" ");
    if (a.startsWith("pr list")) return prs;
    if (a.startsWith("pr view")) return { headRefOid: HEAD, state: "OPEN", isDraft: false, baseRefName: "main" };
    if (/pulls\/42\/reviews\/\d+\/comments/.test(a)) return [posted.at(-1)?.comments ?? []];
    if (a.includes("-X POST") && /pulls\/42\/reviews/.test(a)) {
      const { readFileSync } = await import("node:fs");
      const body = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf8"));
      posted.push(body);
      return { id: 9001, state: body.event === "APPROVE" ? "APPROVED" : body.event, html_url: "https://github.com/acme/shop/pull/42#pullrequestreview-9001" };
    }
    if (/pulls\/42\/reviews/.test(a)) return [[]];
    if (/pulls\/42\/files/.test(a)) return [[{ filename: "src/cart/total.js", patch: PATCH }]];
    if (/pulls\/42\/comments/.test(a)) return [[]];
    throw new Error(`the demo's fake gh doesn't know: gh ${a}`);
  };
  return { json, text: async (args) => JSON.stringify(await json(args)) };
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2"), cyan = paint("36"), green = paint("32"), yellow = paint("33"), bold = paint("1");

export async function demo({ fast = false, popup = true, draft = false, out = console.log } = {}) {
  const pause = (ms) => (fast ? Promise.resolve() : sleep(ms));
  const state = mkdtempSync(join(tmpdir(), "deputy-demo-"));
  const config = merge(DEFAULTS, {
    github: { login: "you" }, repos: ["acme/shop"], posting: draft ? "draft" : "auto", stateDir: state,
    checkouts: { root: join(state, "checkouts") },
  });
  const paths = pathsOf(config);
  const posted = [];
  const gh = fakeGh(posted);
  const step = (icon, text) => out(`${icon} ${text}`);
  let result = null;

  out(bold("deputy demo") + dim(`  (fake GitHub, scripted models, real deputy code; state in ${state})`));
  out("");
  out(dim("Two jobs: pr-review (built in) and failing-ci (your own check). Checks are cheap; a model runs only when one finds work."));

  const runAgent = async ({ items }) => {
    const pr = items[0];
    step(cyan("●"), `Review requested: ${bold(`acme/shop #${pr.number}`)} "${pr.title}" by @${pr.author} ${dim(`(${pr.size})`)}`);
    out(dim("  skipped: #43 is a draft, #44 asks someone else"));
    const R = join(paths.runs, runDirName(pr.repo, pr.number));
    mkdirSync(R, { recursive: true });
    const stage = () => dim(`  status: ${stageOf(readdirSync(R), pr.number)}`);
    await pause(700);

    writeFileSync(join(R, "facts-brief.md"), "collect the diff, threads, CI and who uses cartTotal");
    step(cyan("●"), `Facts  ${dim("legwork tier")}`);
    out(stage());
    await pause(900);
    writeFileSync(join(R, "facts.md"), "cartTotal is used by checkout.js:41 and invoice.js:12. CI green.");
    out(dim("  cartTotal() has 2 callers; CI is green; no other open PR touches src/cart"));

    writeFileSync(join(R, "brief.md"), "review PR 42");
    step(cyan("●"), `Review  ${dim("review tier")}`);
    out(stage());
    await pause(1100);
    const draftReview = {
      event: "APPROVE",
      body: "> [!CAUTION]\n> **Do not merge until the total can't go below zero.**\n>\n> Two coupons worth more than the cart now make `cartTotal` negative, and checkout would send that amount to the payment step.\n\nStacking coupons in one loop reads well, and both callers keep working.",
      comments: [
        { path: "src/cart/total.js", line: 17, side: "RIGHT", body: "Something like `return Math.max(0, subtotal - discount);` would cover it." },
        { path: "src/cart/total.js", line: 88, side: "RIGHT", body: "Worth a test for two coupons larger than the subtotal." },
      ],
    };
    writeFileSync(join(R, "answer.md"), "```json\n" + JSON.stringify(draftReview) + "\n```");
    out(dim("  draft: approve, with one fix before merging (the total can go negative)"));

    writeFileSync(join(R, "challenge-brief.md"), "prove the hold wrong");
    step(yellow("●"), `Challenge  ${dim("challenge tier: money is involved, so a second model tries to disprove the draft")}`);
    out(stage());
    await pause(1100);
    writeFileSync(join(R, "challenge.md"), "Could not disprove: coupons [30, 30] on a 50 cart give -10 (total.js:17).");
    out(dim("  could not disprove it: coupons of 30 and 30 on a 50 cart give -10 (total.js:17)"));

    const file = join(R, `review-${pr.number}.json`);
    const payload = { ...draftReview, _repo: pr.repo, _number: pr.number, commit_id: pr.head, _head_sha: pr.head, _title: pr.title, _url: pr.url };
    writeFileSync(file, JSON.stringify(payload, null, 2));
    step(cyan("●"), "Checking the draft against GitHub");
    let r = await postReview({ file, config, paths, gh });
    for (const l of r.lines.slice(1)) out(l.includes("outside") || l.includes("NOT POSTED") ? yellow(l) : dim(l));
    await pause(600);
    // The way a run fixes a bad anchor: the comment moves into the body.
    const moved = payload.comments.pop();
    payload.body += `\n\n${moved.body}`;
    writeFileSync(file, JSON.stringify(payload, null, 2));
    out(dim("  moved that comment into the review body"));
    r = await postReview({ file, config, paths, gh });
    out(dim(r.lines.at(-1)));
    await pause(500);

    r = await postReview({ file, config, paths, gh, doPost: true });
    result = r.outcome;
    if (r.outcome === "posted") step(green("✔"), `Review posted on acme/shop #42: ${bold("approved, do not merge yet")} ${dim("(1 inline comment)")}`);
    else step(yellow("●"), `Review ${bold("held for you")} (draft mode). In real use: ${cyan("deputy held")}`);
    return { code: 0, out: r.outcome === "posted" ? "acme/shop #42: approved, do not merge until the total can't go below zero." : "acme/shop #42: held for you (draft mode).", log: join(paths.runs, "demo.log") };
  };

  const notify = (title, body) => {
    step(cyan("◆"), `Pop-up: ${bold(title)} ${dim(body)}`);
    if (popup) import("./notify.mjs").then((m) => m.notify(title, body, { enabled: true }));
  };
  // The built-in PR job, plus a job of your own whose check finds nothing today.
  const [prJob] = loadJobs(config);
  const ciJob = { name: "failing-ci", everyMinutes: 15, maxItemsPerRun: 3, check: async () => [], prompt: () => "", label: (i) => i.id };
  const loud = (job, what) => ({ ...job, check: async (ctx) => {
    const found = await job.check(ctx);
    step(cyan("○"), `${job.name} check: ${found.length ? `${found.length} ${what} found` : `nothing to do, no model run`}`);
    return found;
  } });
  const status = await watch({ config, paths, gh, notify, jobs: [loud(ciJob, "failing runs"), loud(prJob, "review request")], runAgent, once: true });
  out("");
  out(describeStatus(status, { alive: true }));
  if (posted.length) out(dim(`fake GitHub received: ${posted[0].event}, ${posted[0].comments.length} inline comment, body starts "${posted[0].body.split("\n")[1]}"`));
  return { outcome: result, posted, state };
}
