# Instructions for Claude Code

The project rules are in AGENTS.md and apply in full:

@AGENTS.md

## Git workflow (owner preference)

- The agent may commit, push, open pull requests and merge them, using the owner's configured git
  identity and `gh` login. Everything is authored by the owner.
- **Never add attribution of any kind**: no `Co-Authored-By` trailers, no "Generated with" lines,
  and no mention of Claude, AI or an assistant in commit messages, PR titles, PR bodies or
  repository text.
- Work on a branch per part, named like `phase-6-part-1-ledger-foundation`, created from an
  up-to-date `main`. Never commit directly to `main`, never force-push, and never rewrite history
  that has been pushed.
- When a part is finished and every check (format, lint, typecheck, tests, build) passes locally:
  1. `git add -A`, review `git status` and the staged diff (no secrets, no stray files).
  2. `git commit -m "<title>" -m "<summary>"`, with a title in the style of recent commits
     (e.g. `Phase 7 Part 2: ...`).
  3. `git push -u origin <branch>`.
  4. `gh pr create` with a summary, test results and known limitations.
  5. `gh pr checks --watch`. If CI fails, fix the cause on the branch and push again; never skip
     or disable checks.
  6. Merge only when every CI check is green: `gh pr merge --squash --delete-branch`. Do not use
     `--admin` to bypass branch protection unless the owner asks for it.
  7. Switch back to `main`, fetch and pull, and report the merged PR to the owner.
- On this machine `git fetch` needs `git -c http.sslBackend=schannel fetch origin` (likewise for
  `pull`).
