// `omit gate --range`: CI recomputes the verdict over a PR's commits, with the
// BASE revision's adoption and mode, so the change cannot loosen its own gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/omit.mjs', import.meta.url))
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', OMIT_NO_EXEC: '1' }
delete ENV.OMIT_MODE
delete ENV.OMIT_OFF
const IDENTITY = ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t']
// A key-shaped fixture, assembled so this file is not itself flagged as holding one.
const KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`
const DEP = '{"dependencies":{"left-pad":"1.0.0"}}\n'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'omit-range-'))
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'ignore'] })
  const put = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  const commit = (msg) => {
    run(['add', '-A'])
    run([...IDENTITY, 'commit', '-q', '-m', msg])
    return run(['rev-parse', 'HEAD']).trim()
  }
  run(['init', '-q', '-b', 'main', '.'])
  return { dir, run, put, commit }
}

const gateRange = (dir, spec = 'main..HEAD', extra = []) => spawnSync('node', [CLI, 'gate', '--range', spec, '--json', ...extra], { cwd: dir, encoding: 'utf8', env: ENV })
const verdict = (r) => JSON.parse(r.stdout)

// An adopted base: .omit/ is tracked, so editorial checks apply.
function adoptedBase() {
  const t = repo()
  t.put('.omit/mode', 'redline\n')
  t.put('README.md', 'hi\n')
  t.commit('base')
  t.run(['branch', 'base'])
  return t
}

test('a secret in a middle commit that a later commit removes still fails', () => {
  const t = repo()
  t.put('a.txt', 'one\n')
  t.commit('base')
  t.put('cfg.js', `const k = "${KEY}"\n`)
  const bad = t.commit('add config')
  rmSync(join(t.dir, 'cfg.js'))
  t.commit('remove it again')
  const r = gateRange(t.dir, 'HEAD~2..HEAD')
  assert.equal(r.status, 1)
  const v = verdict(r)
  assert.equal(v.ok, false)
  assert.deepEqual(v.findings, [{ commit: bad, kind: 'hazard', rule: 'aws-access-key', type: 'secret' }])
  assert.match(r.stderr, /1 secret\(s\) in the range/)
})

test('a PR that sets mode off is still gated with the base mode', () => {
  const t = adoptedBase()
  t.put('.omit/mode', 'off\n')
  t.put('package.json', DEP)
  t.commit('loosen and add a dependency')
  const r = gateRange(t.dir, 'base..HEAD')
  assert.equal(r.status, 1)
  const v = verdict(r)
  assert.equal(v.mode, 'redline')
  assert.equal(v.adopted, true)
  assert.deepEqual(v.findings, [{ kind: 'dep', detail: 'left-pad', rule: 'uncited' }])
})

test('a PR that deletes .omit/ from an adopted base is still gated', () => {
  const t = adoptedBase()
  rmSync(join(t.dir, '.omit'), { recursive: true })
  t.put('package.json', DEP)
  t.commit('drop omit and add a dependency')
  const r = gateRange(t.dir, 'base..HEAD')
  assert.equal(r.status, 1)
  assert.equal(verdict(r).adopted, true)
})

test('adoption comes from the base: not adopted there, editorial checks stay off', () => {
  const t = repo()
  t.put('README.md', 'hi\n')
  t.commit('base')
  t.put('.omit/mode', 'redline\n')
  t.put('package.json', DEP)
  t.commit('adopt and add a dependency in one change')
  const r = gateRange(t.dir, 'HEAD~1..HEAD')
  assert.equal(r.status, 0)
  const v = verdict(r)
  assert.equal(v.adopted, false)
  assert.deepEqual(v.findings, [])
})

test('safety blocks even where the base mode is off', () => {
  const t = repo()
  t.put('.omit/mode', 'off\n')
  t.commit('base')
  t.put('cfg.js', `const k = "${KEY}"\n`)
  t.commit('add config')
  assert.equal(gateRange(t.dir, 'HEAD~1..HEAD').status, 1)
})

test('two runs over the same range are byte-identical, and the verdict is versioned', () => {
  const t = adoptedBase()
  t.put('package.json', DEP)
  t.commit('add a dependency')
  const a = gateRange(t.dir, 'base..HEAD')
  const b = gateRange(t.dir, 'base..HEAD')
  assert.equal(a.stdout, b.stdout)
  const v = verdict(a)
  assert.deepEqual(Object.keys(v), ['adopted', 'base', 'exec', 'findings', 'head', 'mode', 'ok', 'omitVersion', 'rulesHash'])
  assert.match(v.rulesHash, /^[0-9a-f]{64}$/)
  assert.equal(v.exec, false)
  assert.match(v.omitVersion, /^\d+\.\d+\.\d+/)
  assert.doesNotMatch(a.stdout, new RegExp(t.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('a clean merge adds nothing; a merge that resolves a conflict with a secret is flagged', () => {
  const t = repo()
  t.put('a.txt', 'start\n')
  t.commit('base')
  t.run(['checkout', '-q', '-b', 'side'])
  t.put('a.txt', 'side\n')
  t.put('side.txt', 'only on side\n')
  t.commit('side change')
  t.run(['checkout', '-q', 'main'])
  t.put('a.txt', 'main\n')
  t.commit('main change')
  assert.throws(() => t.run([...IDENTITY, 'merge', '--no-commit', 'side']))
  t.put('a.txt', `const k = "${KEY}"\n`)
  const evil = t.commit('merge side')
  const r = gateRange(t.dir, 'HEAD~2..HEAD')
  assert.equal(r.status, 1)
  assert.deepEqual(verdict(r).findings, [{ commit: evil, kind: 'hazard', rule: 'aws-access-key', type: 'secret' }])

  // The same shape, resolved honestly: the merge carries no new line, so it is clean.
  t.run(['reset', '-q', '--hard', 'HEAD~1'])
  assert.throws(() => t.run([...IDENTITY, 'merge', '--no-commit', 'side']))
  t.put('a.txt', 'main and side\n')
  t.commit('merge side')
  assert.equal(gateRange(t.dir, 'HEAD~2..HEAD').status, 0)
})

test('a merge is not re-audited for lines its parents already carry', () => {
  const t = repo()
  t.put('a.txt', 'start\n')
  t.commit('base')
  t.run(['checkout', '-q', '-b', 'side'])
  t.put('side.txt', `const k = "${KEY}"\n`)
  const side = t.commit('side change, gated elsewhere')
  t.run(['checkout', '-q', 'main'])
  t.put('a.txt', 'main\n')
  t.commit('main change')
  t.run([...IDENTITY, 'merge', '--no-edit', '-q', 'side'])
  // Base is the side tip: the incoming branch is already judged, and the merge adds nothing of its own.
  const r = gateRange(t.dir, `${side}..HEAD`)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(verdict(r).findings, [])
})

test('the range head must be the checked-out commit, and bad ranges are refused', () => {
  const t = repo()
  t.put('a.txt', 'one\n')
  t.commit('base')
  t.put('a.txt', 'two\n')
  t.commit('next')
  assert.equal(gateRange(t.dir, 'HEAD~1..HEAD~1').status, 1)
  assert.equal(gateRange(t.dir, 'nonsense..HEAD').status, 1)
  assert.equal(gateRange(t.dir, 'HEAD~1...HEAD').status, 1)
})

test('--base is --range <ref>..HEAD', () => {
  const t = adoptedBase()
  t.put('package.json', DEP)
  t.commit('add a dependency')
  const r = spawnSync('node', [CLI, 'gate', '--base', 'base', '--json'], { cwd: t.dir, encoding: 'utf8', env: ENV })
  assert.equal(r.status, 1)
  assert.equal(verdict(r).findings[0].detail, 'left-pad')
})

test('audit --fail-on gate fails on what the gate would block, and not otherwise', () => {
  const t = adoptedBase()
  t.put('package.json', DEP)
  const audit = (failOn) => spawnSync('node', [CLI, 'audit', '--base', 'HEAD', '--fail-on', failOn], { cwd: t.dir, encoding: 'utf8', env: ENV })
  assert.equal(audit('gate').status, 1) // an uncited dependency is the gate's objection, not a hazard
  assert.equal(audit('hazard').status, 0)
  assert.equal(audit('secret').status, 0)
  assert.equal(audit('none').status, 0)
  const margin = spawnSync('node', [CLI, 'audit', '--base', 'HEAD', '--fail-on', 'gate'], { cwd: t.dir, encoding: 'utf8', env: { ...ENV, OMIT_MODE: 'margin' } })
  assert.equal(margin.status, 0)
})
