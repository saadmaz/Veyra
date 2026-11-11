# Instructions for Claude Code

The project rules are in AGENTS.md and apply in full:

@AGENTS.md

## Git workflow (owner preference)

- Never run `git commit`, `git push`, `git merge` or `git rebase` that creates commits, and never
  add co-author or AI attribution lines. The owner commits and pushes.
- Work on a branch per part, named like `phase-6-part-1-ledger-foundation`, created from an
  up-to-date `main`.
- When a part is finished and every check passes, give the owner PowerShell commands to commit
  and push, each on **one line** (multi-line here-strings break when pasted): `git add -A`,
  `git status`, `git commit -m "<title>" -m "<summary>"`, `git push -u origin <branch>`.
- After the owner pushes, open the pull request with `gh pr create`, watch CI with
  `gh pr checks --watch`, and report the result. The owner merges.
- On this machine `git fetch` needs `git -c http.sslBackend=schannel fetch origin`.
