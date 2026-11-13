# Contributing

`npm test` runs the suite. omit follows its own rules: see [AGENTS.md](AGENTS.md).

## Releasing

```
npm run release -- patch    # or minor / major
```

`scripts/release.mjs` runs the tests, bumps the version, and lands the bump on main through a PR (main takes no direct pushes). Once it merges, the script tags the merge (signed) and pushes the tag, which triggers `publish.yml` to stage the version on npm with a provenance attestation. It then cuts the GitHub release and waits up to 30 minutes while you approve the staged version with your security key (`npm stage list @sriinnu/omit`, then `npm stage approve <id>`). Once npm serves it, the script updates the `omit` formula in [`sriinnu/homebrew-tap`](https://github.com/sriinnu/homebrew-tap), again through a PR. A failed step aborts the release.

Never `npm publish` by hand: a local publish cannot attach provenance, and npm will not let the same version be republished to add one. If the CI publish fails, fix CI.

There is no npm token. `publish.yml` uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers): the workflow proves its identity with a short-lived token GitHub mints for that run, and npm checks it against the publisher configured in the package's settings (GitHub Actions, `sriinnu/omit`, `publish.yml`, stage-only). If staging is refused, check that form. Nothing goes live without your 2FA approval.
