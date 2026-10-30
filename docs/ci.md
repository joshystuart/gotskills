# Pull request CI

The PR workflow runs formatting on Ubuntu and two independent jobs on macOS:

- `app-tests`: TypeScript, all Vitest tests, all Rust tests, and the app size script's tests.
- `tauri-bundle`: the optimized unsigned Tauri build, including the `.app` and DMG, followed by the installed app size limit.

`tauri-build` is the final required check. It runs even when a dependency fails or
is skipped, and succeeds only when formatting, tests, and bundling all succeed.
Keep this check required in branch protection. The workflow's existing path
filters and failure test-report artifact are retained. New commits cancel older
runs for the same PR.

Each macOS job caches its own Cargo artifacts so a debug-only test job cannot
populate a build job's cache without release dependencies. The bundle job uses
the previous `tauri-build` cache key to reuse existing caches; the test cache
needs one warm-up run. Release signing, notarization, and publishing are unchanged.

## Timing evidence

Before this split, the cached macOS job took 237 seconds in
[run 40996860169](https://github.com/joshystuart/gotskills/actions/runs/40996860169)
and 170 seconds in
[run 40992246348](https://github.com/joshystuart/gotskills/actions/runs/40992246348).
The checks before bundling took 73 and 55 seconds respectively, after setup.
The full unsigned build took 113 and 70 seconds, including DMG creation.

Running those phases concurrently removes roughly 55–73 seconds from that
critical path, before accounting for runner queue time, cache differences, and
the final gate's startup. This is an estimate from the old step timings, not a
measurement of the new workflow. Compare subsequent warm-cache runs on GitHub
to establish the actual wall-clock improvement; the first test run has a cold
Cargo cache. Total runner time can increase because setup runs twice.

Run `npm run check` locally. `app/scripts/ciWorkflow.test.ts` exercises the final
gate's shell command for every combination of successful, failed, cancelled,
and skipped dependencies, and checks that the original test/build commands and
macOS coverage remain present.
