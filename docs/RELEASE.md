# Release Process

OpenMozi releases are built and verified on a local macOS machine. GitHub is used only for source tags, the Release page, and artifact hosting. GitHub Actions are intentionally disabled and are not part of the release path.

## Commands

```bash
# Update versioned files only (no git actions)
pnpm version:bump -- --version 1.0.1

# Compute next version from current package.json
pnpm version:bump -- --bump patch
pnpm version:bump -- --bump minor
pnpm version:bump -- --bump major

# One-click unsigned prerelease (explicitly labeled; never promoted as stable)
pnpm release:cut -- --version 2.0.1 --unsigned

# Signed and notarized release (requires the Apple credentials below)
pnpm release:cut -- --version 2.0.1
```

## What the Script Updates

- `package.json` version
- `ui/package.json` version
- `desktop/package.json` version
- `README.md` top version badge
- `CHANGELOG.md` (creates or prepends current release entry)

## Required local tools

- macOS on the target architecture
- Node 22 and pnpm
- authenticated GitHub CLI (`gh auth status`)
- Gitleaks in `PATH`, or `MOZI_GITLEAKS_BIN` pointing to a verified binary
- Apple Developer credentials for a signed release

The release command requires a clean worktree before it changes versions. Run it from an OpenMozi checkout whose `origin` is the public repository.

## Required Release Gates

Before cutting a release, the branch must pass:

- `pnpm build`
- `pnpm verify:prompt-contract`
- `pnpm verify:public-export`
- Gitleaks current-tree scan
- DMG and ZIP build
- packaged macOS smoke matrix
- release manifest and SHA-256 generation
- one real complex task driven end-to-end on the build, with evidence recorded per [COMPLEX-TASK-RELEASE-GATE.md](COMPLEX-TASK-RELEASE-GATE.md). This is a manual step: the automatic gate was removed (see [CONSTITUTION.md](CONSTITUTION.md) §14).

Do not ship a release if MOZI cannot complete at least one real complex task end-to-end on the current build.

For Phase 1 terminal-first acceptance, also review and execute the scenarios in [acceptance-test-plan.md](acceptance-test-plan.md).

Useful diagnostics:

- `pnpm mozi status --workers`
- `pnpm mozi status --workers --live-probe`

## Existing Install Upgrade Path

For an existing install on the same machine, the normal upgrade path is:

1. update the code/package to the new version
2. rebuild if needed
3. restart MOZI

Routine runtime upgrades should not require re-running onboarding. On startup, MOZI reruns DB migrations, synchronizes bootstrap skills/agents, and reloads workspace skills/agents. Re-run onboarding only when changing credentials, providers, or preferences.

## Flags

- `--version <semver>`: explicit target version
- `--bump patch|minor|major`: derive next version from current
- `--commit`: create `chore(release): vX.Y.Z` commit
- `--tag`: create annotated git tag `vX.Y.Z`
- `--push`: push commit and tag to `origin`
- `--release`: create a GitHub Release containing verified macOS assets; it implies `--mac-assets`
- `--mac-assets`: build DMG and ZIP, run packaged smoke, and generate checksummed evidence
- `--unsigned`: disable signing discovery and publish only as an explicitly labeled prerelease
- `--channel stable|beta`: record the release channel in build identity and the manifest
- `--all`: commit, build/verify assets, tag, push, and publish the GitHub Release

`--release` refuses to run without a release commit, tag, push, and verified assets. Empty GitHub Releases are not supported.

## Unsigned prerelease

```bash
brew install gitleaks gh
gh auth login
pnpm release:cut -- --version 2.0.1 --unsigned
```

Unsigned builds are forced to the `beta` channel, GitHub prerelease status, and the title `unsigned macOS prerelease`. They must not be described as signed, notarized, or production-ready.

## Signed and notarized release

Set all required credentials before running the same command without `--unsigned`:

```bash
export CSC_LINK=/secure/path/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD='...'
export APPLE_ID='...'
export APPLE_APP_SPECIFIC_PASSWORD='...'
export APPLE_TEAM_ID='...'
pnpm release:cut -- --version 2.0.1
```

The signed path fails closed unless the packaged app has a valid `Developer ID Application` authority and the DMG passes Apple stapler validation.

## GitHub Release assets

Every created Release contains:

- `MOZI-<version>-arm64.dmg`
- `MOZI-<version>-arm64-mac.zip`
- `OpenMozi-<version>-<channel>-manifest.json`
- `OpenMozi-<version>-SHA256SUMS.txt`

The manifest records source commit, build identity, package versions, artifact sizes and hashes, Developer ID status, notarization status, and explicit blockers. It reports macOS publishability separately from full-product publishability, which additionally requires an immutable Docker image digest. GitHub stores these files but does not build them.
