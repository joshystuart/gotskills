# CI and releases

## Pull request CI

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
needs one warm-up run.

### Timing evidence

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

## Release builds and publishing

Merges to `main`, version tags, and manual dispatches use the release workflow:

1. `resolve-release` runs on Ubuntu, validates the version, and pins the checkout
   to one commit. An already published main version skips all macOS jobs.
2. `build-binaries` builds Apple Silicon and Intel executables concurrently on
   macOS. Each target has its own Cargo cache. Each executable embeds the Vite
   production build and is uploaded as a required artifact.
3. `build-and-release` downloads both executables, validates their architectures,
   restores executable permissions, and combines them with `lipo`. Tauri's
   standalone bundler creates the same universal app, DMG, and signed updater
   archive without compiling either architecture again.

Signing and notarization remain in the protected `release` environment. The job
checks both architectures inside the bundled app, its installed size, its code
signature, and its stapled notarization ticket before writing `latest.json` and
publishing. The updater feed still serves the same universal archive to both
Mac architectures. Failed or missing architecture builds prevent publishing.
Release runs queue instead of cancelling an in-progress publication.

Manual dispatch supports `dry_run: true`. It builds both real architectures and
packages an unsigned universal app/DMG, checks its architecture and size, and
uploads the DMG as an artifact. It skips certificate import, signing,
notarization, updater-feed generation, and GitHub Release publishing. The tag
selects the source being built; `--ref` selects the workflow definition to test:

```bash
gh workflow run tauri-release.yml --ref perf/ci-runtime -f tag=v0.0.16 -F dry_run=true
```

This allows testing a release-workflow change on a branch without replacing a
published release. Dry runs cannot prove Apple signing or notarization; the
next real release exercises those steps with credentials.

### Release timing evidence

[Release run 41029430534](https://github.com/joshystuart/gotskills/actions/runs/41029430534)
took about 5m17s. Its two optimized compilations took 99 and 78 seconds in
sequence. Parallel compilation removes the shorter compilation from that
sequence, with extra runner setup and artifact-transfer overhead. Signing,
notarization, and publishing remain sequential after both builds succeed.
Warm-cache results vary; compare the complete pipeline rather than just
compilation times. Separate caches need to warm up, and total runner time can
increase.

`app/scripts/releaseWorkflow.test.ts` executes release resolution, version
updates, and real Mach-O assembly. It also checks the dry-run publishing guard
and the dependency on both architecture builds. Run the full `npm run check`
before changing either workflow.
