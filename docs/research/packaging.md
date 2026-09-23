# Packaging and releasing a Pi package

Research date: 2026-09-23. Sources: Pi 0.87.1 `docs/packages.md`, the
`earendil-works/pi` monorepo examples, and the release workflows of published
`pi-package` npm packages (Langfuse, LangSmith, gotgenes/pi-packages,
narumiruna/pi-extensions, pi-provider-litellm, pi-subagents).

## What Pi expects

- A `pi` manifest in `package.json` (or conventional `extensions/`, `skills/`,
  `prompts/`, `themes/` directories). Paths are relative to the package root.
- Pi core packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`,
  `typebox`) in `peerDependencies` with `"*"`, never bundled; pinned copies in
  `devDependencies` for typechecking and tests.
- Every other runtime import in `dependencies`: Pi runs `npm install` for npm
  and git sources, and each package gets its own module root.
- The `pi-package` keyword lists an npm package in the pi.dev gallery.
- Sources: `git:…@vX.Y.Z` and `npm:name@X.Y.Z` are both pinned. Pi ships
  TypeScript through jiti, so no build step is needed; `files` decides what an
  npm tarball carries.

## How published packages release

| Pattern | Examples | Version bump |
|---|---|---|
| Tag push → publish | Langfuse, pi-provider-litellm | by hand before tagging; CI only checks tag = `package.json` |
| Changesets release PR | LangSmith, narumiruna | release PR from changeset files |
| Scripted dispatch | gotgenes (retired release-please) | CI commits to `main` |
| Manual dispatch | pi-subagents | by hand |

All npm publishers use `--provenance` with npm Trusted Publishing (OIDC,
`id-token: write`) rather than a stored `NPM_TOKEN`, and pin actions by SHA.

## Choice for PI Lead

A tag can only point at a commit that already holds the new version (Pi
installs the tagged tree), so a tag-triggered bump would need CI to commit and
move the tag. Release Please inverts it: conventional commits on `main` feed a
release PR that bumps the files; merging it creates the tag and GitHub release
with the default `GITHUB_TOKEN`. No workflow pushes to `main`, no secret is
stored. npm publishing is opt-in (`NPM_PUBLISH` repository variable plus a
Trusted Publisher configured on npmjs.com).

Limits: pull requests opened with `GITHUB_TOKEN` do not trigger other
workflows, so CI does not run on the release PR itself (it only touches
version strings and the changelog); a GitHub App token would lift that.
