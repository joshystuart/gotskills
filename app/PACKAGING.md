# Packaging — Got Skills (Phase 0)

Separate Apple Silicon (`arm64`) and Intel (`x64`) macOS DMGs and App Update zips via electron-builder v26+. App Update uses `electron-updater` with the public GitHub Releases feed at `joshystuart/gotskills`.

## Scripts

| Script                  | What it does                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run build:dev`     | Compile + unsigned arm64 and x64 DMGs and zips via `electron-builder.dev.config.mjs` (imports `electron-builder.config.mjs`; `identity: null`, `notarize: false`). |
| `npm run build:release` | Compile + sign + notarize + staple via `electron-builder.config.mjs` when Apple credentials and a Developer ID cert are available.                                 |
| `npm run build`         | Alias of `build:dev` for day-to-day local packaging.                                                                                                               |
| `npm run package:dir`   | Compile + unsigned arm64 app in `dist/mac-arm64/` via `electron-builder.dev.config.mjs`.                                                                           |

Artifact paths: `dist/Got Skills-<version>-arm64.dmg`,
`dist/Got Skills-<version>-x64.dmg`, and matching per-architecture `.zip`
files and `.blockmap` files. `dist/latest-mac.yml` lists both zips so App
Update selects the running Mac's architecture. All are produced in one
build. The dev configuration inherits these targets from the release
configuration. Packaged resources include `app-update.yml` with the GitHub
provider, owner `joshystuart` and repository `gotskills`.

Chromium resources include English locales only, matching the app UI. The
software GPU fallback and Chromium licence remain. DMGs use LZMA (`ULMO`)
compression, supported on macOS 10.15 and later. Electron requires macOS 12
or later.

electron-builder 26 does not list `ULMO` in its configuration schema. The
configuration starts with the supported `ULFO` value, then its `afterPack`
hook selects `ULMO` on the DMG targets before they are built. Compression
still happens before signing and update metadata generation.

## Installer window

Both DMGs open on a branded 660×400 window. The art source is
`build/background.svg`. electron-builder picks up the rendered
`build/background.png` (660×400) and `build/background@2x.png` (1320×800) by
name and merges them into a Retina TIFF. The window size, icon size and icon
positions live in the `dmg` block of `electron-builder.config.mjs`.

After editing the SVG, re-render and commit both PNGs:

```sh
npm run render:dmg-background
```

The render uses `@resvg/resvg-js` and the machine's system fonts; it never
runs during a build. `scripts/dmgBackground.test.ts` fails if the PNGs are
missing, the wrong size, or don't match the configured window.

The `.background.tiff` and `.VolumeIcon.icns` entries in the mounted volume
show only when Finder is set to show hidden files.

## Installed app size budget

PR CI runs `scripts/check-app-size.sh` after `npm run package:dir`. It measures
`dist/mac-arm64/Got Skills.app` with `du -sk`, converts the allocated disk usage
to bytes, and prints the size and limit. An app over **310,000,000 bytes**
(310 MB, decimal) fails the build. Run the same check locally from `app/`,
pass another `.app` path as its first argument, or pass a limit in bytes as its
second argument.

The slimmed arm64 build measured 270,616 KiB (277,110,784 bytes). The budget
adds 10% and rounds up to the next whole 10 MB. This protects installed size;
DMG download size is not part of this check.

Raise `limit_bytes` in `scripts/check-app-size.sh` only for an intentional,
reviewed increase. First inspect the packaged contents for unnecessary files,
then measure a fresh arm64 build, apply the same 10% allowance and rounding,
and record the measurement and reason in the commit. Update this documentation
with the new limit.

Run `node --test scripts/check-app-size.test.cjs` to check the command against
a small fixture app and one over a lowered limit. PR CI runs these tests before
packaging.

## SQLite runtime

The main process uses Electron's built-in `node:sqlite` database. Existing SQLite files and schema versions carry over unchanged. `npm ci` re-signs the local Electron application; no native database compilation is needed. Only the vendored CLI dependency tree needs unpacking.

## Vendored skills CLI

The app forks the vendored `skills` CLI from `app.asar.unpacked`, so the CLI and every module it imports must be unpacked. `scripts/dependencyUnpackGlobs.mjs` walks the `skills` package's production dependencies through `node_modules` at build time and returns an `asarUnpack` glob for each one, so a CLI upgrade that adds a dependency is unpacked without a config change.

`scripts/smoke-packaged-cli.sh [path/to/Got Skills.app]` copies the packaged app out of the project tree, checks an in-memory `node:sqlite` query in the shipped runtime, then runs its binary under `ELECTRON_RUN_AS_NODE=1` against the unpacked CLI to add a fixture skill for Claude Code into a temporary `HOME`. It fails unless the CLI exits 0 and the skill's `SKILL.md` lands. PR CI runs it after `npm run package:dir`. The copy matters: run in place, Node would find missing modules in the project's own `node_modules` and hide the break.

## Fuse deviation

`electronFuses.runAsNode` is **`true`** — the sole documented deviation from the hardened preset — so the vendored `skills` CLI can run under `ELECTRON_RUN_AS_NODE`. Every other fuse is set to its hardened value. Phase 1 exit: move the CLI to `UtilityProcess.fork` and flip `runAsNode: false`.

## Signing & notarization (release)

Required for a Gatekeeper-clean launch on Sequoia+ (no terminal `xattr` steps).

### Apple Developer Program

1. Active **Apple Developer Program** membership ($99/yr).
2. **Developer ID Application** certificate installed in the login keychain (or provided via `CSC_LINK` / `CSC_KEY_PASSWORD`).

Optional: set `CSC_NAME` to the exact identity string if multiple certs are present.

### Notarization auth (pick one)

electron-builder 26 takes `mac.notarize: true` (boolean). Credentials are **env-only** — there is no `notarize.teamId` object in v26.

**App Store Connect API key (preferred):**

- `APPLE_API_KEY` — path to the `.p8` key file
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID` — 10-character Team ID (required for Apple-ID auth path; set it anyway)

**Apple ID + app-specific password:**

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Then:

```bash
npm run build:release
```

electron-builder 26 runs `@electron/notarize` (notarytool) after sign and **staples** the ticket automatically. Without the env vars above it skips notarization (and without a Developer ID cert the build is not Gatekeeper-clean) — use `build:dev` for local verify only.

## GitHub Release (CI)

Signed, notarized DMGs and App Update zips are built by `.github/workflows/electron-release.yml` on `macos-latest`. The build scripts use `--publish never` so electron-builder generates update metadata while `softprops/action-gh-release` uploads the release files.

**Triggers**

| Event                         | Behaviour                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Push tag `v*` (e.g. `v0.0.1`) | Build + create/update GitHub Release with both architectures' release files              |
| Push to `main`                | Build + release when `app/package.json` version has no existing `v{version}` release yet |
| Manual `workflow_dispatch`    | Rebuild an existing tag                                                                  |

**Typical release flow**

1. Bump `version` in `app/package.json` and merge to `main` — CI creates `v{version}` automatically, **or**
2. Merge, then tag and push: `git tag v0.0.1 && git push origin v0.0.1`

**Protected `release` environment secrets:**

Create a GitHub environment named `release`, limit its deployment branches
and tags to `main` and `v*`, and move the Apple signing secrets below into
it. The release build job uses this environment. Configure these protections
before making the repository public.

| Secret                        | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `MAC_CERTIFICATE_P12_BASE64`  | Developer ID Application `.p12`, base64-encoded |
| `MAC_CERTIFICATE_PASSWORD`    | `.p12` export password                          |
| `APPLE_ID`                    | Apple ID for notarization                       |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password                           |
| `APPLE_TEAM_ID`               | 10-character Team ID                            |

Artifacts uploaded: every `app/dist/*.dmg`, `app/dist/*.zip`,
`app/dist/*.blockmap` and `app/dist/latest-mac.yml`. Keep all these files
on each stable GitHub Release: DMGs support manual installs, zips supply
App Update downloads, blockmaps support differential downloads, and
`latest-mac.yml` describes the available version and files.

App Update requires a signed app and a public release feed. Users on 0.0.5
or older install 0.0.6 by hand once to receive subsequent App Updates.
Unsigned dev builds verify packaging only; verify installation with signed
releases on Apple Silicon and Intel (or under Rosetta).

## Entitlements

`build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist` are identical. The inherit file is load-bearing: the forked `ELECTRON_RUN_AS_NODE` child needs JIT entitlements. The app is not sandboxed, so no file-access entitlements are required for installs into `~/.claude` / `~/.cursor` / `~/.agents`.
