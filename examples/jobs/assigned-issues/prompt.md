These issues are assigned to {{LOGIN}} and changed since the last look:

```json
{{ITEMS_JSON}}
```

`deputy` means: {{DEPUTY}}

For each one, prepare a short brief so {{LOGIN}} can start fast. Read only: don't comment, don't change labels.

1. `gh issue view <number> -R <repo> --comments`.
2. Have a cheap model find the code involved: run
   `deputy model --tier legwork --label "{{JOB}} <repo>#<number>" --prompt-file <brief> --out <answer>`
   from a checkout of the repo, asking for the files and functions the issue is about, with file:line.
3. Write the brief to `{{STATE}}/briefs/<repo with - for />-<number>.md`: what is asked, what changed since last time,
   where the code is, open questions.
4. If something needs {{LOGIN}}'s decision right now, ask once with `deputy ask "<question with the issue number>"`.
5. `deputy record {{JOB}} <id> <version> "brief written"`.

End with one line per issue: the issue, and what changed.
