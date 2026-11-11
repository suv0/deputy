// A check for deputy: your own open PRs whose latest CI run failed.
// Prints a JSON list of items; each item's version is the head sha, so a new push is a new item.
//   "jobs": [{ "name": "failing-ci", "check": ["node", "examples/jobs/failing-ci/check.mjs", "your-org/your-app"],
//              "prompt": "examples/jobs/failing-ci/prompt.md", "everyMinutes": 15 }]
import { execFileSync } from "node:child_process";

const repos = process.argv.slice(2);
if (!repos.length) { console.error("usage: node check.mjs <owner/repo> [...]"); process.exit(2); }
const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", shell: process.platform === "win32" }));

const items = [];
for (const repo of repos) {
  const prs = gh(["pr", "list", "-R", repo, "--author", "@me", "--state", "open", "--json", "number,title,url,headRefOid,statusCheckRollup"]);
  for (const pr of prs) {
    const failed = (pr.statusCheckRollup ?? []).filter((c) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(c.conclusion ?? c.state));
    if (!failed.length) continue;
    items.push({
      id: `${repo}#${pr.number}`, version: pr.headRefOid, title: `${repo.split("/")[1]} #${pr.number} CI`,
      repo, number: pr.number, url: pr.url, prTitle: pr.title, failedChecks: failed.map((c) => c.name ?? c.context),
    });
  }
}
console.log(JSON.stringify(items));
