// A check for deputy: open issues assigned to you that changed since deputy last looked.
// The version is the issue's update time, so a new comment or label brings it back.
//   "jobs": [{ "name": "assigned-issues", "check": ["node", "examples/jobs/assigned-issues/check.mjs", "your-org/your-app"],
//              "prompt": "examples/jobs/assigned-issues/prompt.md", "everyMinutes": 30 }]
import { execFileSync } from "node:child_process";

const repos = process.argv.slice(2);
if (!repos.length) { console.error("usage: node check.mjs <owner/repo> [...]"); process.exit(2); }
const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", shell: process.platform === "win32" }));

const items = [];
for (const repo of repos) {
  for (const issue of gh(["issue", "list", "-R", repo, "--assignee", "@me", "--state", "open", "--json", "number,title,url,updatedAt,labels"])) {
    items.push({
      id: `${repo}#${issue.number}`, version: issue.updatedAt, title: `${repo.split("/")[1]} issue ${issue.number}`,
      repo, number: issue.number, url: issue.url, issueTitle: issue.title, labels: issue.labels.map((l) => l.name),
    });
  }
}
console.log(JSON.stringify(items));
