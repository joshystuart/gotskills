# Packaging — Got Skills

Got Skills is a Tauri v2 app: a Rust backend in `src-tauri` and a Vite-built React renderer. Releases are universal macOS builds (Apple Silicon and Intel in one binary). App Update uses the Tauri updater against the public GitHub Releases feed at `joshystuart/gotskills`.

## Scripts

| Script                  | What it does                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run dev`           | `tauri dev`: starts Vite on port 1420 and the Rust app with hot reload.                                           |
| `npm run build`         | `tauri build`: unsigned `.app` and DMG under `src-tauri/target/release/bundle/` for local verification.           |
| `npm run build:release` | `tauri build` with updater artifacts enabled. Needs `TAURI_SIGNING_PRIVATE_KEY` and Apple credentials in the env. |
| `npm run test:rust`     | `cargo test` in `src-tauri`.                                                                                      |

`tauri.conf.json` runs `npx vite build` before bundling; Vite writes the renderer to `out/renderer`, which is the `frontendDist`.

## Installer window

The DMG opens on a branded 660×400 window. The art source is `build/background.svg`; the rendered `build/background.png` (660×400) and `build/background@2x.png` (1320×800) are committed. The window size, background and icon positions live under `bundle.macOS.dmg` in `src-tauri/tauri.conf.json`.

After editing the SVG, re-render and commit both PNGs:

```sh
npm run render:dmg-background
```

`scripts/dmgBackground.test.ts` fails if the PNGs are missing, the wrong size, or inconsistent with the configured window.

## Installed app size budget

PR CI runs `scripts/check-app-size.sh` after `npm run build`. It measures `src-tauri/target/release/bundle/macos/Got Skills.app` with `du -sk` and fails above **60,000,000 bytes** (60 MB, decimal). Pass a different bundle path or limit as arguments. `scripts/check-app-size.test.cjs` covers the script.

## Signing and notarization

Release builds are signed with a Developer ID Application certificate, with the hardened runtime and `build/entitlements.mac.plist`, and notarized by Tauri's bundler. Tauri reads these env vars:

| Variable                 | Value                                     |
| ------------------------ | ----------------------------------------- |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`               | Apple ID used for notarization            |
| `APPLE_PASSWORD`         | App-specific password for that Apple ID   |
| `APPLE_TEAM_ID`          | Developer Team ID                         |

Without them the build is unsigned and Gatekeeper blocks it on other Macs.

## Updater

The updater verifies downloads with a minisign key pair made by `npx tauri signer generate`. Keep the private key in the `TAURI_SIGNING_PRIVATE_KEY` secret (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). The public key and the `latest.json` endpoint belong in the `plugins.updater` block of `tauri.conf.json`:

```
https://github.com/joshystuart/gotskills/releases/latest/download/latest.json
```

`scripts/updaterFeed.mjs` writes `latest.json` from the `.app.tar.gz` and `.sig` that Tauri produces, for both `darwin-aarch64` and `darwin-x86_64`.

## GitHub Release (CI)

`.github/workflows/tauri-release.yml` runs on version tags, pushes to `main` (skipped when the release already exists) and manual dispatch. It:

1. Resolves the tag and version.
2. Sets the version in `app/package.json` and `app/src-tauri/Cargo.toml`.
3. Imports the Developer ID certificate into a temporary keychain.
4. Runs `npm run build:release -- --target universal-apple-darwin`.
5. Uploads `Got-Skills-<version>-universal.dmg`, `Got-Skills-<version>-universal.app.tar.gz` and `latest.json` to the release.

Required secrets in the `release` environment: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

For a feature or fix, bump the patch version in `app/package.json`, `app/package-lock.json` and `app/src-tauri/Cargo.toml` in the same PR.

## PR CI

`.github/workflows/pr-tauri.yml` runs prettier, typecheck, `npm test`, `npm run test:rust`, the size-check test, an unsigned `npm run build` and the app size check. `scripts/checkDrift.test.ts` fails when a workflow step is not run by the root `npm run check`.
