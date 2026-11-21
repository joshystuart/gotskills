/implement-spec existing-skill-collisions dont ask me any questions, just execute until you are done.

When you finish, every change must be committed in this checkout, on the branch checked out now or on one you leave checked out, with no worktrees left behind.

`app/scripts/releaseWorkflow.test.ts` fails on this machine because its `sed -i ''` only works on macOS. That is in the base commit: don't fix or look into it. `npm run check` stops there, so run its steps one by one, with `npx vitest run --exclude scripts/releaseWorkflow.test.ts` in `app/` in place of `npm test`.
