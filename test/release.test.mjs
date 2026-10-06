// The release script runs a few times a year and only ever for real: it pushes
// tags, publishes to npm and opens PRs on another repository. Nothing executes
// it in between, so what can be checked without releasing is checked here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const path = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const json = (rel) => JSON.parse(readFileSync(path(rel), 'utf8'))

// The Homebrew formula is a template literal inside the script, so one stray
// backtick in the Ruby ends the string and the script stops parsing. That
// shipped as far as a commit once, and would have surfaced on release day.
test('scripts/release.mjs parses', () => {
  execFileSync(process.execPath, ['--check', path('scripts/release.mjs')], { stdio: 'pipe' })
})

// Claude Code reads the plugin's version from its manifest, not from
// package.json, and nothing kept the two together: the manifest sat a release
// behind while the package moved on.
test('the plugin manifest carries the package version', () => {
  assert.equal(json('.claude-plugin/plugin.json').version, json('package.json').version)
})

// A workflow snippet that names an older release tells every new adopter to
// install it. The release script moves these pins with the version; this is
// what notices when a pin is added somewhere it does not look.
test('the docs pin the Action to the package version', () => {
  const pin = `sriinnu/omit@v${json('package.json').version}`
  for (const doc of ['README.md', 'GETTING-STARTED.md']) {
    const pins = readFileSync(path(doc), 'utf8').match(/sriinnu\/omit@\S+/g) ?? []
    assert.ok(pins.length, `${doc} no longer shows how to use the Action`)
    for (const found of pins) assert.equal(found, pin, doc)
  }
})

// The sandbox is declared twice on purpose: as an optional peer for whoever
// installs omit, and as a dev dependency so a checkout installs it and keeps
// it. The formula is built from the peer range, so the two must agree.
test('the sandbox is declared at one range, as an optional peer and for development', () => {
  const pkg = json('package.json')
  const name = '@earendil-works/pi-codemode'
  assert.equal(pkg.devDependencies[name], pkg.peerDependencies[name])
  assert.equal(pkg.peerDependenciesMeta[name].optional, true)
  assert.equal(pkg.dependencies, undefined)
})
