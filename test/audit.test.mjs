// CLI-level tests for `audit`/`gate`. These exist because the bugs they cover
// lived in bin/omit.mjs's git plumbing, not in any scanner — untracked files
// were invisible to the audit, and the verdict carried a fabricated score.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/omit.mjs', import.meta.url))
// No global config: a developer's commit signing must not leak into the fixture.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

// Secrets have no override — `omit-allow:` quiets an injection finding, never a
// secret one — so a fixture that needs a key-shaped string builds it from
// fragments. A literal would make this file uncommittable by its own scanner.
const KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`

// The developer's global git signs commits, so every fixture commit carries its
// own identity and turns signing off explicitly.
const IDENTITY = ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t']

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'omit-audit-'))
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'ignore'] })
  run(['init', '-q', '.'])
  run([...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'base'])
  return { dir, run, commit: (msg) => run([...IDENTITY, 'commit', '-q', '-m', msg]) }
}

const omit = (dir, args) => spawnSync('node', [CLI, ...args], { cwd: dir, encoding: 'utf8', env: ENV })

test('audit counts an untracked file, which git diff alone cannot see', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'new.js'), 'const a = 1\nconst b = 2\nconst c = 3\n')
  const r = omit(dir, ['audit'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /net: \+3 −0 lines across 1 file/)
})

test('audit reports hazards in an untracked file', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'new.js'), `const k = "${KEY}"\n`)
  const r = omit(dir, ['audit'])
  assert.match(r.stdout, /hazards: secret:aws-access-key/)
})

test('audit leaves omit\'s own ledger out of the change it measures', () => {
  const { dir } = repo()
  mkdirSync(join(dir, '.omit'), { recursive: true })
  writeFileSync(join(dir, '.omit', 'final-draft.md'), 'net: +0 -0\n')
  const r = omit(dir, ['audit'])
  assert.match(r.stdout, /net: \+0 −0 lines across 0 files/)
})

// A gate judges the commit; an untracked file is not in the commit.
test('gate ignores untracked files and judges only the staged diff', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'new.js'), `const k = "${KEY}"\n`)
  assert.equal(omit(dir, ['gate']).status, 0)
  assert.equal(omit(dir, ['audit']).status, 0) // same file, but the audit does report it
})

test('gate blocks a secret in a staged file', () => {
  const { dir, run } = repo()
  writeFileSync(join(dir, 'leak.js'), `const k = "${KEY}"\n`)
  run(['add', 'leak.js'])
  assert.equal(omit(dir, ['gate']).status, 1)
})

// The verdict used to end in a weighted score that footnotes could raise by
// adding lines — a fabricated number in a tool whose rule is "claims need
// receipts". Raw counts only now.
test('the verdict carries no score', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'a.js'), '// omitted: nothing worth recording\n')
  const r = omit(dir, ['audit'])
  assert.doesNotMatch(r.stdout, /score/i)
  assert.match(r.stdout, /footnotes: 1 recorded/)
})

test('a new dependency in a new untracked manifest is reported', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } }))
  const r = omit(dir, ['audit'])
  assert.match(r.stdout, /new deps: 1: left-pad/)
})

test('audit says so plainly outside a git repository instead of crashing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omit-nogit-'))
  const r = omit(dir, ['audit'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not a git repository/)
})

// ---- receipts are checked, not taken on the agent's word ----

const withDep = (dir) => {
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const padTo = (s) => s\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } }))
}
const ledger = (dir, ...lines) => {
  mkdirSync(join(dir, '.omit'), { recursive: true })
  writeFileSync(join(dir, '.omit', 'receipts.jsonl'), lines.join('\n') + '\n')
}

test('a receipt that only names a dependency does not cite it', () => {
  const { dir, run } = repo()
  withDep(dir)
  ledger(dir, JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad' })) // the old shape: an assertion and nothing more
  run(['add', '-A'])
  const r = omit(dir, ['gate'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /without a verified receipt: left-pad/)
})

test('a verified new-dep receipt cites the dependency and the gate passes', () => {
  const { dir, run } = repo()
  withDep(dir)
  // `absent` names a symbol the checker searches the whole tracked tree for, and
  // it is genuinely absent, so the omission really does not hold.
  ledger(dir, JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'formatPad' }] }))
  run(['add', '-A'])
  assert.equal(omit(dir, ['gate']).status, 0)
})

test('a receipt whose own evidence refutes it is a fabricated citation, and the gate refuses it', () => {
  const { dir, run } = repo()
  withDep(dir)
  // Claims reuse does not apply, while searching for a symbol that IS in the tree.
  ledger(dir, JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'padTo' }] }))
  run(['add', '-A'])
  const r = omit(dir, ['gate'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /did not survive their own check/)
  assert.match(r.stderr, /actually HOLDS/)
})

test('omit verify reports every claim, and passes only when all of them survived', () => {
  const { dir } = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const padTo = (s) => s\n')
  ledger(
    dir,
    JSON.stringify({ claim: 'reuse', rung: 2, file: 'src/util.ts', line: 1, symbol: 'padTo' }),
    // `run` evidence has to name its subject, and the argv has to mention it.
    JSON.stringify({ claim: 'stdlib', rung: 3, api: 'process.exit', run: ['node', '-e', 'process.exit(1)'] })
  )
  const r = omit(dir, ['verify'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✅ line\s+1\s+verified/)
  assert.match(r.stdout, /⛔ line\s+2\s+failed/)
  assert.match(r.stdout, /1\/2 claims survived/)
})

test('omit verify says so plainly when nothing was claimed', () => {
  const { dir } = repo()
  const r = omit(dir, ['verify'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /nothing to check/)
})

// ---- a diff git could not read is an error, never an empty result ----
// Every test below failed before this suite's changes, and each one covers a
// different way the same substitution happened: "git could not answer" was
// coalesced to '', and '' reads exactly like "there is nothing here" — so the
// verdict stayed green while nothing had been examined.

test('a diff past the 1 MiB buffer is read, not reported as a clean change', () => {
  const { dir, run, commit } = repo()
  writeFileSync(join(dir, 'big.js'), 'const a = 1\n')
  run(['add', '-A'])
  commit('one')
  // The added side alone is past Node's default 1 MiB exec buffer: the numstat
  // half survives (small) while the patch half used to throw ENOBUFS and read as
  // an empty diff — correct-looking counts over a change nothing had scanned.
  const big = Array.from({ length: 70000 }, (_, i) => `const v${i} = ${i}`).join('\n')
  writeFileSync(join(dir, 'big.js'), `const a = 1\n${big}\nconst k = "${KEY}"\n`)
  const r = omit(dir, ['audit'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /net: \+70001 −0 lines across 1 file/)
  assert.match(r.stdout, /hazards: secret:aws-access-key/)
})

test('an added line that begins with ++ is scanned, not dropped as a diff header', () => {
  const { dir, run, commit } = repo()
  writeFileSync(join(dir, 'notes.md'), 'first\n')
  run(['add', '-A'])
  commit('notes')
  // In the patch this line is `+++ AKIA…` — indistinguishable from a post-image
  // header by prefix alone, which is how a secret on it went unscanned.
  writeFileSync(join(dir, 'notes.md'), `first\n++ ${KEY}\n`)
  const r = omit(dir, ['audit'])
  assert.match(r.stdout, /net: \+1 −0 lines across 1 file/)
  assert.match(r.stdout, /hazards: secret:aws-access-key/)
})

test('a dependency added in a rename commit is reported, not lost to the brace path', () => {
  const { dir, run, commit } = repo()
  mkdirSync(join(dir, 'cfg'), { recursive: true })
  // Long enough that adding one dependency does not stop git from recognising the
  // rename — the brace path below is the whole point, and a short manifest makes
  // git emit a plain delete/add pair instead.
  const manifest = (extra = {}) =>
    JSON.stringify(
      {
        name: 'x',
        version: '1.0.0',
        description: 'a fixture manifest long enough that adding a dependency does not stop git from seeing the rename',
        main: 'index.js',
        license: 'MIT',
        repository: { type: 'git', url: 'https://example.invalid/x.git' },
        keywords: ['a', 'b', 'c'],
        ...extra,
      },
      null,
      2
    ) + '\n'
  writeFileSync(join(dir, 'cfg', 'package.json'), manifest())
  run(['add', '-A'])
  commit('one')
  run(['mv', 'cfg', 'pkg'])
  writeFileSync(join(dir, 'pkg', 'package.json'), manifest({ dependencies: { 'left-pad': '^1.3.0' } }))
  run(['add', '-A'])
  commit('rename')
  // numstat prints this path as `{cfg => pkg}/package.json`, which is not a path:
  // both `git show` and the filesystem read fail on it, both revisions read as
  // empty, and the dependency goes uncited.
  const r = omit(dir, ['audit', '--base', 'HEAD~1'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /new deps: 1: left-pad/)
})

test('an unresolvable base is refused instead of rendering a clean empty verdict', () => {
  const { dir } = repo()
  const typo = omit(dir, ['audit', '--base', 'origin/main'])
  assert.equal(typo.status, 1)
  assert.match(typo.stderr, /origin\/main/)
  assert.doesNotMatch(typo.stdout, /net: /)

  // The dangerous shape: `src` is not a revision, but git reads an unresolvable
  // argument as a PATHSPEC, so it answers — with a diff of that directory,
  // rendered as a verdict about the change. A range that is not a revision has to
  // be refused before git gets to guess.
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.js'), 'const a = 1\n')
  const asPath = omit(dir, ['audit', '--base', 'src'])
  assert.equal(asPath.status, 1)
  assert.match(asPath.stderr, /not a revision/)
  assert.doesNotMatch(asPath.stdout, /net: /)
})

test('an audit is refused in a repo whose HEAD has no commits yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omit-unborn-'))
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env: ENV, stdio: 'ignore' })
  writeFileSync(join(dir, 'a.js'), 'const a = 1\n')
  const r = omit(dir, ['audit'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not a revision/)
})

test('a path git calls binary is scanned by content, not erased from the change', () => {
  const { dir, run, commit } = repo()
  const file = join(dir, 'config.js')
  writeFileSync(file, 'const a = 1\n')
  run(['add', '-A'])
  commit('config')
  // A repo can tell git a file is binary. That is a representation choice, and it
  // must not decide what gets scanned: numstat reports `-` and the patch carries
  // no `+` line, so the secret below used to commit with `hazards: 0 ✅`.
  writeFileSync(join(dir, '.git', 'info', 'attributes'), 'config.js -diff\n')
  writeFileSync(file, `const a = 1\nconst k = "${KEY}"\n`)
  run(['add', '-A'])
  const r = omit(dir, ['gate'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /across 1 file/)
  assert.match(r.stdout, /hazards: secret:aws-access-key/)
})

test('a dependency-shaped file omit cannot parse is reported, not read as a clean zero', () => {
  const { dir } = repo()
  // `new deps: 0 ✅` is a claim about the whole change. Where a file omit cannot
  // read changed, that claim is one nothing backs.
  writeFileSync(join(dir, 'setup.py'), "from setuptools import setup\nsetup(install_requires=['paramiko'])\n")
  const r = omit(dir, ['audit'])
  assert.equal(r.status, 0)
  assert.doesNotMatch(r.stdout, /new deps: 0 ✅/)
  assert.match(r.stdout, /new deps: 0 \(1 dependency-shaped file not parsed\)/)
  assert.match(r.stdout, /unparsed deps: setup\.py/)
  assert.match(omit(dir, ['audit', '--markdown']).stdout, /unparsed deps: setup\.py/)
  assert.match(omit(dir, ['audit', '--json']).stdout, /"unparsed": \[\s*"setup\.py"\s*\]/)
})

// ---- the repo root, not the caller's cwd, is what git paths are relative to ----

test('auditing from a subdirectory reports the same change as auditing from the root', () => {
  const { dir } = repo()
  mkdirSync(join(dir, 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } }))
  writeFileSync(join(dir, 'pkg', 'a.js'), 'const a = 1\nconst b = 2\n')
  const fromRoot = omit(dir, ['audit'])
  const fromSub = omit(join(dir, 'pkg'), ['audit'])
  assert.equal(fromSub.status, 0)
  assert.match(fromSub.stdout, /new deps: 1: left-pad/) // the root manifest, seen from inside pkg/
  assert.equal(fromSub.stdout, fromRoot.stdout)
})

// ---- the gate weighs the ledger the commit carries ----

test('a ledger that is not part of the commit cites nothing', () => {
  const { dir, run } = repo()
  withDep(dir)
  ledger(dir, JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'formatPad' }] }))
  run(['add', 'package.json', 'src/util.ts']) // the ledger itself is left untracked, as an agent's scratch file is
  const r = omit(dir, ['gate'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not part of this commit/)
})

test('a staged ledger that is not the one on disk is refused', () => {
  const { dir, run } = repo()
  withDep(dir)
  // The bogus one is staged and the good one is left on disk: verifying the disk
  // file passes, and the commit ships the other one.
  ledger(dir, JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'ghost' }] }))
  run(['add', '-A'])
  ledger(dir, JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'formatPad' }] }))
  const r = omit(dir, ['gate'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /is not the file on disk/)
})

// ---- nothing-to-check is not a pass ----

test('verify refuses to read "no ledger" as "nothing to check" when a manifest changed', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } }))
  const r = omit(dir, ['verify'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /package\.json/)
})

test('a shadowed hooks path is reported, not turned into a false objection', () => {
  const { dir, run } = repo()
  writeFileSync(join(dir, 'a.js'), 'const a = 1\n')
  assert.equal(omit(dir, ['gate']).status, 0)
  // `git config core.hooksPath /tmp/empty` disarms the pre-commit gate and shows
  // up in no diff at all — the config is the only trace there is, so it belongs
  // in the verdict. It is not fatal: a global hooks directory is a legitimate
  // setup, and failing every commit over the user's own configuration is a false
  // objection. `hook install` writing where git actually looks is the real fix.
  run(['config', 'core.hooksPath', '/tmp/omit-empty-hooks'])
  const r = omit(dir, ['gate'])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /core\.hooksPath/)
  assert.match(omit(dir, ['audit']).stdout, /hooks: core\.hooksPath/)
})

// ---- the gate's remediation template has to be a receipt that verifies ----

test('following the gate’s own remediation template verbatim unblocks the commit', () => {
  const { dir, run } = repo()
  withDep(dir)
  run(['add', '-A'])
  const blocked = omit(dir, ['gate'])
  assert.equal(blocked.status, 1)
  const template = blocked.stderr.match(/\{"claim":"new-dep".*\}/)
  assert.ok(template, `no receipt template in the gate output:\n${blocked.stderr}`)
  ledger(dir, template[0]) // copied out of the error message, unchanged
  run(['add', '-A'])
  assert.equal(omit(dir, ['verify']).status, 0, 'the printed receipt did not survive `omit verify`')
  assert.equal(omit(dir, ['gate']).status, 0, 'the printed receipt did not unblock the gate')
})
