import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { verifyReceipt, verifyLedger, newDepCitations, declaredDeps, readLedger } from '../lib/receipts.mjs'

// A real repo, because absence evidence is reconstructed by searching the
// tracked tree — a fixture without git cannot answer that question.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

function fixture({ files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omit-receipts-'))
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'ignore'] })
  git(['init', '-q', '.'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'util.ts'), 'export function parseRange(s) {\n  return s.split("-")\n}\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { zod: '^3.22.0' } }))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  git(['add', '-A'])
  git(['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'])
  return dir
}

const status = (r, dir) => verifyReceipt(r, dir).status
const detail = (r, dir) => verifyReceipt(r, dir).checks.map((c) => c.detail).join(' ')

// ---- reuse: "the codebase already does this" ----

test('a reuse claim verifies when the file, line, and symbol are really there', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'reuse', rung: 2, file: 'src/util.ts', line: 1, symbol: 'parseRange' }, dir), 'verified')
})

test('a reuse claim fails when the symbol is not there, or the line is past the end', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'reuse', rung: 2, file: 'src/util.ts', line: 1, symbol: 'splitRange' }, dir), 'failed')
  assert.equal(status({ claim: 'reuse', rung: 2, file: 'src/util.ts', line: 400, symbol: 'parseRange' }, dir), 'failed')
})

test('a reuse claim fails when the file does not exist, and when it is outside the repo', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'reuse', rung: 2, file: 'src/ghost.ts', line: 1, symbol: 'x' }, dir), 'failed')
  assert.equal(status({ claim: 'reuse', rung: 2, file: '../../etc/hosts', line: 1, symbol: 'localhost' }, dir), 'failed')
})

// The `\b` assertions that used to wrap the symbol made any citation ending in a
// non-word character permanently unfalsifiable, so an honest agent was told its
// accurate citation was a fabrication.
test('a call-form symbol is matched as a literal, not as a pattern', () => {
  const dir = fixture()
  for (const symbol of ['parseRange(s)', 'parseRange']) {
    assert.equal(status({ claim: 'reuse', rung: 2, file: 'src/util.ts', line: 1, symbol }, dir), 'verified', symbol)
  }
})

// A citation naming a directory used to throw EISDIR out of the check, which in
// the hook exits 1 — a non-blocking error, i.e. the objection silently vanished.
test('a citation resolving to a directory is a verdict, never a throw', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'reuse', rung: 2, file: '.', line: 1, symbol: 'x' }, dir), 'failed')
  assert.equal(status({ claim: 'reuse', rung: 2, file: 'src', line: 1, symbol: 'x' }, dir), 'failed')
})

// A symlink inside the repo reaches outside it. The containment check is lexical
// only if it skips realpath, and then a citation can read an arbitrary file.
test('a symlink pointing outside the repo is refused', () => {
  const dir = fixture()
  symlinkSync('/etc/hosts', join(dir, 'link.ts'))
  assert.equal(status({ claim: 'reuse', rung: 2, file: 'link.ts', line: 1, symbol: 'localhost' }, dir), 'failed')
})

// existsSync follows symlinks, so a ledger that is a link to /dev/zero used to
// block every caller forever — gate, hooks and CI included.
test('a ledger that is not a regular file is reported, and does not hang', () => {
  const dir = fixture()
  mkdirSync(join(dir, '.omit'), { recursive: true })
  symlinkSync('/dev/zero', join(dir, '.omit', 'receipts.jsonl'))
  const read = readLedger(dir)
  assert.deepEqual(read.entries, [])
  assert.match(read.error, /not a regular file|resolves to/)
  assert.deepEqual(verifyLedger(dir), [])
})

// ---- stdlib / installed-dep: "the standard library covers it" ----

test('a stdlib claim verifies only when the snippet names the API and runs', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'stdlib', rung: 3, api: 'crypto.randomUUID', run: ['node', '-e', 'crypto.randomUUID()'] }, dir), 'verified')
})

test('a stdlib claim fails when the named API does not run — a fabricated citation', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'stdlib', rung: 3, api: 'crypto.randomUUIDs', run: ['node', '-e', 'crypto.randomUUIDs()'] }, dir), 'failed')
})

// The finding that made the whole mechanism vacuous: any dependency could be
// cited with a snippet that exits on demand and exercises nothing.
test('a snippet that exercises nothing is unverifiable, not evidence', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'stdlib', rung: 3, run: ['true'] }, dir), 'unverifiable')
  assert.equal(status({ claim: 'stdlib', rung: 3, api: 'String.prototype.padStart', run: ['true'] }, dir), 'unverifiable')
  assert.match(detail({ claim: 'stdlib', rung: 3, api: 'String.prototype.padStart', run: ['false'] }, dir), /does not mention/)
})

test('an installed-dep claim needs the dep declared AND a snippet that exercises it', () => {
  const dir = fixture()
  // Installed for real, so the snippet genuinely resolves it rather than merely
  // naming it. Written after the commit so it stays out of the tracked tree.
  mkdirSync(join(dir, 'node_modules', 'zod'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'zod', 'index.js'), 'module.exports = { object: 1 }\n')
  const run = ['node', '-e', "require('zod').object"]
  assert.equal(status({ claim: 'installed-dep', rung: 5, dep: 'zod', run }, dir), 'verified')
  assert.equal(status({ claim: 'installed-dep', rung: 5, dep: 'zod', run: ['node', '-e', '0'] }, dir), 'unverifiable') // names nothing
  assert.equal(status({ claim: 'installed-dep', rung: 5, dep: 'left-pad', run }, dir), 'failed') // not declared, though the snippet names it
})

test('a snippet that cannot be spawned fails rather than passing quietly', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'stdlib', rung: 3, api: 'omit-not-a-real-binary', run: ['omit-not-a-real-binary'] }, dir), 'failed')
})

test('run is argv, never a shell: metacharacters in an argument stay literal', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'stdlib', rung: 3, api: 'a;b', run: ['node', '-e', '0', 'a;b'] }, dir), 'verified')
})

// SIGTERM is catchable, so a child that ignores it held the caller — and
// therefore `git commit` — open indefinitely.
test('a snippet that ignores SIGTERM is still killed', () => {
  const dir = fixture()
  const api = 'hang'
  const started = Date.now()
  const result = status({ claim: 'stdlib', rung: 3, api, run: ['node', '-e', `process.on('SIGTERM',()=>{});console.log('${api}');setTimeout(()=>{},600000)`] }, dir)
  assert.ok(Date.now() - started < 40_000, 'the check did not return promptly')
  assert.ok(result === 'failed' || result === 'verified', `unexpected status ${result}`)
})

// ---- OMIT_NO_EXEC ----

test('OMIT_NO_EXEC disarms on any explicit off-value, not just the literal 1', () => {
  const dir = fixture()
  const r = { claim: 'stdlib', rung: 3, api: 'process.exit', run: ['node', '-e', 'process.exit(0)'] }
  for (const value of ['1', 'true', 'TRUE', 'yes']) {
    process.env.OMIT_NO_EXEC = value
    try {
      assert.equal(status(r, dir), 'unverifiable', `OMIT_NO_EXEC=${value} should disarm`)
    } finally {
      delete process.env.OMIT_NO_EXEC
    }
  }
  for (const value of ['', '0', 'false']) {
    process.env.OMIT_NO_EXEC = value
    try {
      assert.equal(status(r, dir), 'verified', `OMIT_NO_EXEC=${value} should not disarm`)
    } finally {
      delete process.env.OMIT_NO_EXEC
    }
  }
})

// ---- new-dep: the strongest claim, and the one that catches fabrication ----

test('a new-dep claim verifies when the omission it cites is genuinely absent', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'padTo' }] }, dir), 'verified')
})

// The whole point: the author claims reuse does not apply, and the verifier
// searches for itself. A symbol that IS there refutes the author's own claim.
test('a new-dep claim is refuted when the omission it dismissed actually holds', () => {
  const dir = fixture()
  const result = verifyReceipt({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'parseRange' }] }, dir)
  assert.equal(result.status, 'failed')
  assert.match(result.checks.map((c) => c.detail).join(' '), /is present at src\/util\.ts/)
})

// Citing a path that simply does not exist was the cheapest way to fake "I tried
// reuse" — it produced ok:false and was read as proof the omission failed.
test('a tried entry that cites nothing checkable is unverifiable, not proof', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, file: 'src/ghost.ts', line: 1, symbol: 'padTo' }] }, dir), 'unverifiable')
  assert.equal(status({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 3, run: ['false'] }] }, dir), 'unverifiable')
})

// The ledger necessarily contains the symbol it claims is absent — it is a claim
// about the code, not code. Searching it found the receipt that named the
// symbol, so every new-dep receipt refuted itself in any repo that tracks it.
test('the ledger is not part of the tree that absence is searched in', () => {
  const line = JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'padTo' }] })
  const dir = fixture({ files: { '.omit/receipts.jsonl': line + '\n' } })
  assert.equal(verifyLedger(dir)[0].status, 'verified')
})

test('a tried entry naming an api is read as a stdlib attempt, not as a location', () => {
  const dir = fixture()
  const missing = { rung: 3, api: 'Array.prototype.groupByNothing', run: ['node', '-e', 'Array.prototype.groupByNothing()'] }
  assert.equal(status({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [missing] }, dir), 'verified')
  assert.match(detail({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [missing] }, dir), /genuinely does not hold/)

  // The inverse: an API that does work means the standard library already covers it.
  const present = { rung: 3, api: 'String.prototype.padEnd', run: ['node', '-e', 'String.prototype.padEnd && "x".padEnd(3)'] }
  const refuted = verifyReceipt({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [present] }, dir)
  assert.equal(refuted.status, 'failed')
  assert.match(refuted.checks.map((c) => c.detail).join(' '), /actually HOLDS/)
})

test('a new-dep claim with nothing tried is unverifiable — the omissions ARE the evidence', () => {
  const dir = fixture()
  assert.equal(status({ claim: 'new-dep', rung: 7, dep: 'left-pad' }, dir), 'unverifiable')
  assert.equal(status({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [] }, dir), 'unverifiable')
})

test('a tried entry carrying both a dep and a run is judged on the dep', () => {
  const dir = fixture()
  // Once read as stdlib, a failing run "proved" the omission and the manifest
  // check never ran. It must be checked as the installed-dep attempt it is.
  const r = { claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 5, dep: 'zod', run: ['false'] }] }
  assert.notEqual(status(r, dir), 'verified')
  assert.match(detail(r, dir), /does not mention/)
})

// ---- untrusted input ----

// Indexing an object literal with an untrusted claim string resolved to an
// Object.prototype member and crashed the whole run, hiding every other verdict.
test('a claim naming an Object.prototype member is a verdict, not a crash', () => {
  const dir = fixture()
  for (const claim of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', 'make-it-nice']) {
    assert.equal(status({ claim, rung: 6 }, dir), 'unverifiable', claim)
  }
})

test('a poisoned claim inside tried does not take the rest of the ledger with it', () => {
  const dir = fixture()
  const r = { claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ claim: 'constructor', rung: 2 }] }
  assert.equal(status(r, dir), 'unverifiable')
})

test('a malformed ledger line is reported, not thrown, and does not hide the lines around it', () => {
  const dir = fixture()
  mkdirSync(join(dir, '.omit'), { recursive: true })
  writeFileSync(join(dir, '.omit', 'receipts.jsonl'), [
    '{"claim":"reuse","file":"src/util.ts","line":1,"symbol":"parseRange"}',
    '{not json',
    '',
  ].join('\n'))
  const results = verifyLedger(dir)
  assert.equal(results.length, 2)
  assert.equal(results[0].status, 'verified')
  assert.equal(results[1].status, 'unverifiable')
  assert.match(results[1].checks[0].detail, /not valid JSON/)
})

// A refuted check must outrank an undetermined one: otherwise disabling
// execution downgrades every refutation to a warning, and the gate stops firing.
test('a refuted check is not masked by an undetermined one', () => {
  const dir = fixture()
  const r = { claim: 'installed-dep', rung: 5, dep: 'not-declared-anywhere', run: ['node', '-e', 'not-declared-anywhere'] }
  process.env.OMIT_NO_EXEC = '1'
  try {
    assert.equal(status(r, dir), 'failed') // the manifest half is refuted; the run half is undetermined
  } finally {
    delete process.env.OMIT_NO_EXEC
  }
})

test('only a verified new-dep receipt cites a dependency', () => {
  const dir = fixture()
  mkdirSync(join(dir, '.omit'), { recursive: true })
  writeFileSync(join(dir, '.omit', 'receipts.jsonl'), [
    JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'padTo' }] }),
    JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'lodash', tried: [{ rung: 2, absent: 'parseRange' }] }),
    JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'chalk' }),
  ].join('\n'))
  const citations = newDepCitations(dir)
  assert.equal(citations.get('left-pad').status, 'verified')
  assert.equal(citations.get('lodash').status, 'failed')
  assert.equal(citations.get('chalk').status, 'unverifiable')
})

test('declaredDeps finds dependencies across the repo manifests', () => {
  const dir = fixture()
  assert.ok(declaredDeps(dir).has('zod'))
  assert.ok(!declaredDeps(dir).has('left-pad'))
})
