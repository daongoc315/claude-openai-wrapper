# Contributing

Thanks for your interest in contributing.

## Development setup

1. Install dependencies:

   ```bash
   bun install
   ```

2. Run checks locally:

   ```bash
   bun run typecheck
   bun run test
   bun run audit
   bun run check:version
   bun run build
   bun run ci
   ```

## Pull requests

- Keep changes focused and scoped.
- Add or update tests when behavior changes.
- Ensure CI passes before requesting review.

## Commit and release process

This project uses [Conventional Commits](https://www.conventionalcommits.org/) so that Release Please can generate accurate changelogs and determine version bumps automatically.

Common prefixes:

| Prefix | When to use |
|---|---|
| `feat:` | A new feature (triggers a minor bump) |
| `fix:` | A bug fix (triggers a patch bump) |
| `docs:` | Documentation-only changes |
| `chore:` | Maintenance, tooling, dependency updates |
| `refactor:` | Code restructuring without behavior change |
| `test:` | Adding or updating tests |

Breaking changes: add `BREAKING CHANGE:` in the commit body or append `!` after the type (e.g. `feat!:`). This triggers a major bump.

Releases are automated with Release Please: merging a release PR to `main` creates a GitHub Release and publishes to npm.

## Code of conduct

By participating in this project, you agree to follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
