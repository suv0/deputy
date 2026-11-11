These pull requests of yours have failing CI checks:

```json
{{ITEMS_JSON}}
```

`deputy` means: {{DEPUTY}}

For each one, work out why CI fails. Don't change any code and don't push anything.

1. `gh pr checks <number> -R <repo>`, then `gh run view <run id> -R <repo> --log-failed` for each failing check.
2. Have a cheap model read the logs: write the failing lines to a brief and run
   `deputy model --tier legwork --label "{{JOB}} <repo>#<number>" --prompt-file <brief> --out <answer>`.
   Ask it for the first real error, the file and line it points at, and whether the base branch fails the same way
   (`gh run list -R <repo> --branch <base> --limit 3`).
3. Check its answer against the log yourself.
4. `deputy record {{JOB}} <id> <version> "<one-line cause>"`.

End with one line per PR: what fails, why, and whether it's this PR or the base branch. deputy shows the end of
your answer in a pop-up, so keep those lines short.
