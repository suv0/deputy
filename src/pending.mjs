// Which open pull requests wait on your review right now.
//
// A PR waits on you when you (or one of your teams) are a requested reviewer. GitHub drops you
// from that list once you review, and puts you back when the author asks again, so the list
// itself is the queue. Drafts, your own PRs, and heads deputy already handled are left out.

export function doneHead(entry) {
  return typeof entry === "string" ? entry : entry?.version ?? entry?.head ?? null;
}

function requestedFrom(pr, login, teams) {
  const me = login.toLowerCase();
  const myTeams = teams.map((t) => t.toLowerCase());
  return (pr.reviewRequests ?? []).some((r) => {
    if (r.login) return r.login.toLowerCase() === me;
    // Team requests carry a slug or a name, sometimes with the org in front.
    const names = [r.slug, r.name].filter(Boolean).map((n) => n.toLowerCase());
    return names.some((n) => myTeams.includes(n) || myTeams.includes(n.split("/").pop()));
  });
}

/**
 * Pure filter over `gh pr list --json ...` rows for one repo.
 * @returns rows that wait on `login`, oldest number first.
 */
export function selectPending(repo, prs, { login, teams = [], done = {}, job = "pr-review" }) {
  return prs
    .filter((pr) => pr.state === "OPEN" && !pr.mergedAt && !pr.isDraft)
    .filter((pr) => pr.author?.login?.toLowerCase() !== login.toLowerCase())
    .filter((pr) => requestedFrom(pr, login, teams))
    .filter((pr) => doneHead(done[`${job}:${repo}#${pr.number}`]) !== pr.headRefOid)
    .sort((a, b) => a.number - b.number);
}

/** From a PR's reviews: did you review before, at which commit, and who else approved this head. */
export function summarizeReviews(reviews, login, head) {
  const me = login.toLowerCase();
  const latest = new Map();
  for (const r of reviews) if (r.user?.login) latest.set(r.user.login, r);
  const mine = reviews.filter((r) => r.user?.login?.toLowerCase() === me);
  return {
    reReview: mine.length > 0,
    myLastReviewedCommit: mine.at(-1)?.commit_id ?? null,
    approvedAtHeadBy: [...latest.values()]
      .filter((r) => r.user.login.toLowerCase() !== me && r.state === "APPROVED" && r.commit_id === head)
      .map((r) => r.user.login),
  };
}

export const PR_FIELDS = "number,title,author,headRefOid,baseRefName,isDraft,state,mergedAt,additions,deletions,reviewRequests,url";

/** Ask GitHub, through `gh`, for everything that waits on you across the watched repos. */
export async function findPending({ config, gh, done, job = "pr-review" }) {
  const out = [];
  for (const repo of config.repos) {
    const prs = await gh.json(["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", PR_FIELDS]);
    for (const pr of selectPending(repo, prs, { login: config.github.login, teams: config.github.teams, done, job })) {
      const reviews = (await gh.json(["api", `repos/${repo}/pulls/${pr.number}/reviews`, "--paginate", "--slurp"])).flat();
      out.push({
        repo, number: pr.number, title: pr.title, author: pr.author?.login ?? null, url: pr.url,
        head: pr.headRefOid, base: pr.baseRefName, size: `+${pr.additions}/-${pr.deletions}`,
        ...summarizeReviews(reviews, config.github.login, pr.headRefOid),
      });
    }
  }
  return out;
}
