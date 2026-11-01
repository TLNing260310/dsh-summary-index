# Contributing

Thanks for trying this AI-assisted alpha/demo plugin and helping make it safer.

## Before opening an issue

1. Confirm your DSH version and `dsh-summary-index` version.
2. Run `sumidx_probe action=status` and include the sanitized admission reason codes.
3. Remove credentials, full session text, file contents, and personal data.
4. Search existing issues first.

Please use the bug report template for crashes, missing index entries, false quarantine,
failed GitHub/npm installs, and compaction compatibility problems.

## Local development

~~~bash
npm ci --ignore-scripts
npm test
npm run check
npm pack --dry-run
~~~

The current test matrix uses DSH API packages `0.2.1-rc.2` and Node 24. The runtime path
also supports session format v3/v4 producer sources.

## Pull requests

- Keep the plugin non-invasive: no compaction backend replacement and no direct
  `session.append()`.
- Add a regression test for every bug fix.
- Keep tools in the `sumidx_` namespace.
- Update `README.md`, `CHANGELOG.md`, `docs/audit-2026-11-01.zh.md`, and
  `dsh-plugin.naming.json` when behavior or config changes.
- Distinguish borrowed ideas from code implemented in this repository.
- Do not include secrets or real session logs in fixtures.

## Version compatibility

If a DSH API change requires an adapter, prefer adding a narrowly scoped compatibility
branch with tests instead of widening the plugin into the compaction backend. The
project intentionally treats compaction as an external dependency.

## Publishing to npm

The package name is `dsh-summary-index` and `dsh.bundle.patch` is declared in
`package.json`. The manual `publish-npm.yml` workflow runs tests, naming checks, and
`npm publish --provenance` when triggered from the Actions tab.

Repository setup required before the first npm publish:

1. Add a repository secret named `NPM_TOKEN` (npm automation token with publish
   permission for `dsh-summary-index`).
2. Create the npm package name if the registry requires an owner step.
3. Manually run the `Publish npm package` workflow from the Actions tab.

A local maintainer can also publish with:

~~~bash
npm login
npm ci --ignore-scripts
npm test
npm run check
npm publish --access public
~~~

## Security

Do not open a public issue containing credentials or private logs. Use GitHub private
security advisories for sensitive reports.
