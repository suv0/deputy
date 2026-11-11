# Review checklist

A general checklist for reviewing one pull request. It is meant to be replaced: copy it, add your
team's own rules, and point `context.checklist` in the config at your copy.

## 1. Read the PR

1. Note the repository, the PR's real base branch, the head sha, the author, the description and the CI state.
2. Read the full diff against the base: `git diff origin/<base>...HEAD`.
3. **Re-review:** if the reviewer reviewed this PR before, list what changed since their last review, and check
   each of their earlier comments in the code at the new head, not from the author's reply: fixed, partly fixed,
   pushed back with a reason, still open, or no longer applies. When the author pushed back with a reason that
   holds, drop the point.
4. **Related PRs:** other open PRs that change the same files or a shared contract (types, an API client, a
   schema or migration). For each, say whether merging one first breaks or conflicts with the other.
5. **CI:** for each red check, find out whether this PR causes it or whether it also fails on the base branch.
   Read the failing step rather than guessing from the job name.
6. Read the existing review threads, so you don't repeat a comment that is already there.
7. **Design first.** Before the line-by-line pass, ask whether the approach is right: the right module, the right
   place for the logic, the right shape. If the design is wrong, that one comment leads the review.

## 2. Check it against the docs

If the team keeps architecture or product docs, map each changed area to the docs that govern it and look for:

- **Drift:** the code does something the docs say not to do.
- **Gap:** the code does something the docs don't cover yet, and someone should decide it.
- **Stale docs:** the code is right and the docs are out of date.
- **Unfinished:** the docs promise something this PR was meant to deliver and doesn't.

Cite the doc file and line, with a short quote, for every finding that rests on a doc.

## 3. Check the code

- **Correctness:** edge cases, empty and missing values, error paths, off-by-one, time zones, rounding.
- **Money and personal data:** amounts, currency, rounding, refunds, who can read what. These get the closest look.
- **Security:** authentication and permission checks on every new route, input validation, secrets in code or
  logs, injection.
- **Failure and retries:** what happens when a call fails halfway, when it runs twice, when two run at once.
- **Data:** migrations that lock, fail or lose data on a real table; a column dropped while code still reads it.
- **Silent failures:** errors swallowed, a fallback that hides a real problem.

## 4. Blast radius

For each changed export, route, event, setting or table, find who uses it on the base branch (other apps, SDKs,
config, background jobs) and say what breaks for them, if anything. Deploy config and environment variables count.

## 5. Tests

Would the tests in this PR catch the regression that matters? Name a missing test only when it would catch a
real failure, and say which.

## 6. Before drafting

- Open the file and line behind every finding you keep. Drop what you can't prove.
- Separate real problems from preferences. Preferences are optional suggestions, or nothing.
- Prefer one clear comment over several small ones.
- Say what you could not check (a live environment, a build you couldn't run).
