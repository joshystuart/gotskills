Build the plan in {{plan}}. Build every ticket yourself in the main agent; don't use subagents. Don't stop to ask questions; work until every ticket is done. When you finish, every change must be committed in this checkout, with no worktrees left behind and none committed.

`app/scripts/releaseWorkflow.test.ts` fails on this machine because its `sed -i ''` only works on macOS. That is in the base commit: don't fix or look into it. `npm run check` stops there, so run its steps one by one, with `npx vitest run --exclude scripts/releaseWorkflow.test.ts` in `app/` in place of `npm test`.
