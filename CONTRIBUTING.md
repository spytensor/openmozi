# Contributing to OpenMozi

Thank you for improving OpenMozi. Contributions must preserve truthful runtime behavior, user privacy, and parity between the Web/Docker and macOS App surfaces.

## Before opening an issue

- Search existing issues first.
- Use the structured Bug, Feature, or Documentation form.
- Never post credentials, tokens, personal data, private paths, proprietary documents, or unredacted logs.
- Report vulnerabilities through GitHub Private Vulnerability Reporting, not a public issue.

## Development workflow

1. Fork or branch from the current `main`.
2. Read `AGENTS.md` and `docs/CONSTITUTION.md` before changing runtime behavior.
3. Keep Web and macOS App behavior in shared code unless a platform requirement is documented.
4. Add or update regression coverage with the implementation.
5. Run the relevant local tests and `pnpm verify:public-export`.
6. Open a focused pull request using the repository template and report only checks that actually ran.

GitHub Actions are intentionally disabled. Pull requests therefore require explicit local verification evidence; an empty check list is not proof that a change passed.

## Security and privacy

Before every push, inspect the staged diff and remove secrets and private data. OpenMozi also enables GitHub Secret Scanning and Push Protection, but contributors must not rely on server-side detection as their only control.

## Release changes

Release-related changes must preserve the fail-closed rules in `docs/RELEASE.md`: unsigned builds are labeled as such, signed builds require verifiable Developer ID and notarization evidence, and GitHub Releases must contain checksummed artifacts rather than an empty release page.
