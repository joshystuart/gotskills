/xf-build existing-skill-collisions --autopilot

This repository has no git remote, on purpose. Don't stop or ask about it, and don't add one. Run the build with these overrides to the skill:

- **The repository itself is the remote.** Wherever the skill says "the remote", use `.`: "fetch" is a no-op, "the remote tip of a branch" is the local branch, and the build ledger is `init`ed with `.` as its remote (`git fetch . <branch>` works for `next`).
- **Base.** Ignore `Base branch: main` in the grill record; `main` may not exist. The base is the commit checked out now (`git rev-parse HEAD` before you change anything). Use that SHA wherever the skill needs the base or its remote ref, including as `<base>` for the final review. Leave the grill record's header lines as they are.
- **Integration branch.** Create `feat/external-skill-conflicts` locally from that commit. Build in worktrees and keep the main checkout off this branch until the end.
- **Landing.** A ticket counts as landed once its commit, with its trailer, is on the local integration branch. Read every "pushed" or "on the remote" as "committed on the local integration branch". Instead of pushing, mergers fast-forward the local branch from their worktree with `git push . HEAD:feat/external-skill-conflicts` (never force); treat a rejection as `PUSH_REJECTED`. Implementers still don't touch the integration branch.
- **No pull requests**, draft or otherwise. Criteria that need CI on a pull request stay open for the report.
- **Run to the end without pausing:** every ticket, the full checks, the final review and its fixes. Take the recommended option at every choice point.
- **When done,** check out `feat/external-skill-conflicts` in the main checkout with all landed work on it, and leave it there, so the diff against the base commit shows the changes.
