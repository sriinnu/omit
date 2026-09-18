import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isManifest, unparsedDependencyFile, addedDeps, parseDeps } from '../lib/deps.mjs'

const BOM = '\uFEFF'
const pkg = (deps, extra = {}) => JSON.stringify({ name: 'x', version: '1.0.0', dependencies: deps, ...extra })

test('isManifest recognizes known manifest filenames', () => {
  assert.ok(isManifest('package.json'))
  assert.ok(isManifest('path/to/requirements.txt'))
  assert.ok(isManifest('Cargo.toml'))
  assert.ok(!isManifest('README.md'))
  assert.ok(!isManifest('package-lock.json'))
})

// The bug this replaced: dependencies were read by matching diff lines, so only
// pretty-printed JSON matched. A minified manifest passed the gate untouched.
test('a new dependency is found however the manifest is formatted', () => {
  const before = pkg({ 'left-pad': '^1.0.0' })
  const added = { 'left-pad': '^1.0.0', lodash: '^4.17.21' }
  assert.deepEqual(addedDeps('package.json', before, pkg(added)), ['lodash'])
  assert.deepEqual(addedDeps('package.json', before, JSON.stringify({ name: 'x', version: '1.0.0', dependencies: added })), ['lodash'])
})

// The other half of the same bug: any quoted key with a version-shaped value
// matched the old line pattern, so bumping your own version demanded a receipt.
test('the manifest\'s own metadata is not a dependency', () => {
  assert.deepEqual(addedDeps('package.json', pkg({}), pkg({}, { version: '2.0.0' })), [])
  assert.deepEqual(addedDeps('Cargo.toml', '[package]\nversion = "0.1.0"', '[package]\nversion = "0.2.0"'), [])
})

test('every dependency table counts, not just `dependencies`', () => {
  const before = pkg({})
  const after = pkg({}, { devDependencies: { vitest: '^2' }, peerDependencies: { react: '^19' }, optionalDependencies: { fsevents: '^2' } })
  assert.deepEqual(addedDeps('package.json', before, after).sort(), ['fsevents', 'react', 'vitest'])
})

test('composer.json reads require and require-dev', () => {
  const before = JSON.stringify({ require: { 'php': '^8.2', 'monolog/monolog': '^3.0' } })
  const after = JSON.stringify({ require: { 'php': '^8.2', 'monolog/monolog': '^3.0', 'guzzlehttp/guzzle': '^7.0' }, 'require-dev': { 'phpunit/phpunit': '^11' } })
  assert.deepEqual(addedDeps('composer.json', before, after).sort(), ['guzzlehttp/guzzle', 'phpunit/phpunit'])
})

// A manifest that didn't exist before has no earlier revision — every
// dependency in it is new. `npm init` + `npm i` used to walk straight through.
test('a manifest with no earlier revision declares everything as new', () => {
  assert.deepEqual(addedDeps('package.json', '', pkg({ 'left-pad': '^1.3.0' })), ['left-pad'])
  assert.deepEqual(addedDeps('requirements.txt', '', 'flask==3.0'), ['flask'])
})

test('an unparseable manifest objects rather than reporting nothing', () => {
  // Invalid JSON: the line fallback is deliberately noisy — a false objection is
  // recoverable, a silently missed dependency is not.
  assert.deepEqual(addedDeps('package.json', pkg({}), '{ "dependencies": { "left-pad": "^1.3.0" } '), ['left-pad'])
})

// npm tolerates a leading BOM, so a BOM'd manifest installs fine. JSON.parse
// does not, and the fallback used to demand a version-shaped value — so
// `"left-pad": "latest"` was silently not a dependency.
test('a BOM does not hide a dependency, in either direction', () => {
  assert.deepEqual(addedDeps('package.json', BOM + pkg({}), BOM + pkg({ 'left-pad': 'latest' })), ['left-pad'])
  // The other direction: a BOM'd manifest must not report its own metadata as a
  // dependency (the flat quoted-pair scan this replaced did exactly that).
  assert.deepEqual(addedDeps('package.json', BOM + pkg({}), BOM + pkg({}, { version: '2.0.0' })), [])
})

test('a BOM does not hide a dependency however the range is spelled', () => {
  const ranges = { latest: 'latest', star: '*', ws: 'workspace:*', file: 'file:../x', git: 'git+https://host/r.git', alias: 'npm:alias@^1', ge: '>=1.0.0' }
  const added = addedDeps('package.json', BOM + pkg({}), BOM + pkg(ranges))
  assert.deepEqual(added.sort(), Object.keys(ranges).sort())
})

// The fallback has to be table-scoped: widening it to any quoted pair would
// report `"version": "2.0.0"` as a dependency again.
test('the unparseable fallback reads dependency tables, not quoted pairs', () => {
  const broken = '{ "name": "x", "version": "1.0.0", "dependencies": { "left-pad": "^1.3.0" }'
  assert.deepEqual(addedDeps('package.json', '', broken), ['left-pad'])

  const meta = '{ "name": "x", "version": "2.0.0", "engines": { "node": ">=18" }'
  assert.deepEqual(addedDeps('package.json', '', meta), [])
})

test('the unparseable fallback reads bundled dependencies too', () => {
  const broken = '{ "name": "x", "dependencies": { "left-pad": "^1.3.0" }, "bundledDependencies": ["lodash", "chalk"]'
  assert.deepEqual(parseDeps('package.json', broken).sort(), ['chalk', 'left-pad', 'lodash'])
})

test('requirements.txt takes names, not options, extras, or markers', () => {
  const content = ['# a comment', '-r other.txt', '--hash=sha256:abc', 'requests[security]==2.31.0', 'numpy>=1.24; python_version<"3.12"', 'Flask'].join('\n')
  assert.deepEqual(parseDeps('requirements.txt', content), ['requests', 'numpy', 'flask'])
})

test('go.mod reads require blocks and single-line directives, not the go directive', () => {
  const before = ['module x', 'go 1.22', '', 'require (', '\tgithub.com/a/b v1.0.0', ')'].join('\n')
  const after = ['module x', 'go 1.23', '', 'require (', '\tgithub.com/a/b v1.0.0', '\tgithub.com/c/d v2.1.0 // indirect', ')', '', 'require github.com/e/f v0.3.0'].join('\n')
  assert.deepEqual(addedDeps('go.mod', before, after), ['github.com/c/d', 'github.com/e/f'])
})

test('Cargo.toml: table membership decides, not the key name', () => {
  const base = ['[package]', 'name = "x"', 'version = "0.1.0"', '', '[dependencies]', 'serde = "1"'].join('\n')
  assert.deepEqual(addedDeps('Cargo.toml', base, base.replace('0.1.0', '0.2.0')), [])
  assert.deepEqual(addedDeps('Cargo.toml', base, base + '\nregex = "1"'), ['regex'])
})

test('Cargo.toml: a nested dependency table names the dependency itself', () => {
  const base = ['[dependencies]', 'serde = "1"'].join('\n')
  const after = base + '\n\n[dependencies.tokio]\nversion = "1"\nfeatures = ["rt"]'
  assert.deepEqual(addedDeps('Cargo.toml', base, after), ['tokio'])
})

// Cargo resolves the shared table for every member crate, so a dependency
// declared there is a dependency of the repo.
test('Cargo.toml: [workspace.dependencies] declares dependencies too', () => {
  const before = ['[workspace]', 'members = ["a"]', '', '[workspace.dependencies]', 'serde = "1"'].join('\n')
  assert.deepEqual(addedDeps('Cargo.toml', before, before + '\nregex = "1"'), ['regex'])
  const nested = before + '\n\n[workspace.dependencies.tokio]\nversion = "1"'
  assert.deepEqual(addedDeps('Cargo.toml', before, nested), ['tokio'])
})

// TOML allows the quoted spelling of any key, including a nested table name.
test('Cargo.toml: a quoted nested table names the dependency', () => {
  const before = '[dependencies]\nserde = "1"'
  assert.deepEqual(addedDeps('Cargo.toml', before, before + '\n\n[dependencies."my-crate"]\nversion = "1"'), ['my-crate'])
})

test('pyproject.toml: PEP 621 arrays, including one that spans lines', () => {
  const before = ['[project]', 'dependencies = ["requests>=2.31"]', '', '[build-system]', 'requires = ["setuptools>=68"]'].join('\n')
  const after = ['[project]', 'dependencies = [', '  "requests>=2.31",', '  "flask>=3",', ']', '', '[build-system]', 'requires = ["setuptools>=68"]'].join('\n')
  assert.deepEqual(addedDeps('pyproject.toml', before, after), ['flask'])
})

test('pyproject.toml: optional-dependency groups, poetry tables, and interpreter pins', () => {
  const before = ['[tool.poetry.dependencies]', 'python = "^3.11"', 'requests = "^2.31"'].join('\n')
  const after = [before, 'httpx = "^0.27"', '', '[tool.poetry.group.dev.dependencies]', 'pytest = "^8"'].join('\n')
  assert.deepEqual(addedDeps('pyproject.toml', before, after), ['httpx', 'pytest'])
  assert.deepEqual(parseDeps('pyproject.toml', before), ['requests']) // `python` is an interpreter pin, not a dependency
})

// An unclosed `[` used to consume to EOF and then read whatever it swallowed as
// array entries — the next table's `version = "1.0.0"` arrived as a dependency.
test('pyproject.toml: an unterminated array does not read a value as a name', () => {
  const content = ['[project]', 'dependencies = [', '  "requests>=2.31",', '', '[package]', 'version = "1.0.0"'].join('\n')
  assert.deepEqual(parseDeps('pyproject.toml', content), ['requests'])
})

test('pyproject.toml: an unterminated array stops at the next table', () => {
  const content = ['[project]', 'dependencies = [', '  "requests>=2.31",', '', '[tool.poetry.dependencies]', 'flask = "^3"'].join('\n')
  assert.deepEqual(parseDeps('pyproject.toml', content).sort(), ['flask', 'requests'])
})

// The reader re-scanned the whole accumulator per line, so a big array cost
// ~5x per doubling (40k lines > 1s). Linear now; the bound is loose on purpose.
test('a large multi-line array is read in linear time', () => {
  const lines = ['[project]', 'dependencies = [']
  for (let i = 0; i < 50000; i++) lines.push(`  "pkg${i}>=1",`)
  lines.push(']')
  const started = Date.now()
  const names = parseDeps('pyproject.toml', lines.join('\n'))
  const took = Date.now() - started
  assert.equal(names.length, 50000)
  assert.ok(took < 1000, `50000 lines took ${took}ms`)
})

test('Gemfile reads gem lines, and a trailing comment is not part of the name', () => {
  const before = "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\n"
  assert.deepEqual(addedDeps('Gemfile', before, before + "gem 'puma', '~> 6.4' # the server\n"), ['puma'])
})

// A `#` inside a quoted spec is not a comment (poetry/uv pin git deps this way).
test('a fragment inside a quoted dependency spec is not read as a comment', () => {
  const spec = 'pkg = { git = "https://github.com/a/b#subdirectory=lib" }'
  assert.deepEqual(parseDeps('pyproject.toml', '[tool.poetry.dependencies]\n' + spec), ['pkg'])
})

// ---- coverage: manifests that used to report `new deps: 0` unread ----
test('the manifests borrowed from other ecosystems are recognized', () => {
  for (const f of ['requirements-dev.txt', 'Pipfile', 'environment.yml', 'environment.yaml', 'setup.cfg']) assert.ok(isManifest(f), f)
})

test('requirements-dev.txt is read like requirements.txt', () => {
  assert.deepEqual(addedDeps('requirements-dev.txt', 'pytest==8.0', 'pytest==8.0\nruff==0.5'), ['ruff'])
})

test('Pipfile reads [packages] and [dev-packages], not [requires]', () => {
  const before = ['[[source]]', 'name = "pypi"', 'url = "https://pypi.org/simple"', '', '[packages]', 'requests = "*"', 'urllib3 = {version = ">=2", extras = ["socks"]}', '', '[requires]', 'python_version = "3.11"'].join('\n')
  assert.deepEqual(parseDeps('Pipfile', before), ['requests', 'urllib3'])
  assert.deepEqual(addedDeps('Pipfile', before, before + '\n\n[dev-packages]\npytest = "*"'), ['pytest'])
})

test('environment.yml reads the conda list, including pip sub-entries', () => {
  const before = ['name: x', 'channels:', '  - conda-forge', 'dependencies:', '  - python=3.11', '  - numpy >= 1.24', '  - pip'].join('\n')
  assert.deepEqual(parseDeps('environment.yaml', before), ['python', 'numpy', 'pip'])
  const after = before + '\n  - pip:\n      - requests==2.31'
  assert.deepEqual(addedDeps('environment.yml', before, after), ['requests'])
})

test('setup.cfg reads install_requires and extras_require', () => {
  const before = ['[metadata]', 'name = x', 'version = 1.0', '', '[options]', 'packages = find:', 'install_requires =', '    requests>=2.31', '    flask'].join('\n')
  assert.deepEqual(parseDeps('setup.cfg', before), ['requests', 'flask'])
  const after = before + '\n\n[options.extras_require]\ndev =\n    pytest>=8\n    ruff'
  assert.deepEqual(addedDeps('setup.cfg', before, after).sort(), ['pytest', 'ruff'])
})

// The other half of the coverage gap: a dependency file we still cannot read
// has to be reportable, or the gate says `0 ✅` for a manifest it never opened.
test('unparsedDependencyFile names the dependency files we do not parse', () => {
  for (const f of ['setup.py', 'build.gradle', 'build.gradle.kts', 'Package.swift', 'src/App/App.csproj']) assert.ok(unparsedDependencyFile(f), f)
  // ...and not the ones we do parse, nor the generated lockfiles.
  for (const f of ['package.json', 'Pipfile', 'setup.cfg', 'requirements-dev.txt', 'environment.yml', 'README.md', 'package-lock.json', 'Cargo.lock', 'go.sum']) assert.ok(!unparsedDependencyFile(f), f)
})
