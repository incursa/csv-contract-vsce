# Repository guidance

- Keep canonical validation formats and behavior documented in the README and `docs/`.
- Preserve local-only processing, explicit database authorization, and protected-data boundaries.
- Run `npm ci` and `npm run release:check` for changes that affect extension behavior, packaging, or validation logic.
- Keep durable documentation free of branch, commit, deployment, point-in-time validation, test-count, package-count, exact-latest-version, and unfinished-work status. Put release history in `CHANGELOG.md`, workflow evidence in the relevant run, and active planning in issues or pull requests.
