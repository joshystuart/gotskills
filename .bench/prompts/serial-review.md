/xf-build-serial existing-skill-collisions --autopilot

This repository has no git remote, on purpose. Don't stop or ask about it, and don't add one. Run the build with these overrides to the skill:

- **Base.** Ignore `Base branch: main` in the grill record; `main` may not exist. The base is the commit checked out now (`git rev-parse HEAD` before you change anything). Use that SHA wherever the skill needs the base, including as `{base}` for the final review. Leave the grill record's header lines as they are.
- **Temp folder.** Use `$TMPDIR/xf/existing-skill-collisions/` as the build's temp folder, not `/tmp`.
- **Known failing test.** `app/scripts/releaseWorkflow.test.ts` fails on this machine because its `sed -i ''` only works on macOS. That is in the base commit: don't fix or look into it. `npm run check` stops there, so run its steps one by one, with `npx vitest run --exclude scripts/releaseWorkflow.test.ts` in `app/` in place of `npm test`.
- **Integration branch.** Create `feat/external-skill-conflicts` locally from that commit. Build in the skill's worktree and keep the main checkout off this branch until the end.
- **Run to the end without pausing:** every ticket, the final review and its fixes, and the full checks. Take the recommended option at every choice point.
- **Don't push.** When the skill offers to push, take "Leave it local" without asking.
- **When done,** check out `feat/external-skill-conflicts` in the main checkout with all landed work on it, and leave it there, with no worktrees left behind, so the diff against the base commit shows the changes.
