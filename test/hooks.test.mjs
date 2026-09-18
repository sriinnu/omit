// Hook-level tests: each hook is fed a real tool payload on stdin and judged by
// its exit code, because that IS the contract with the harness. These exist
// because every bug they cover lived in that contract — exit 2 blocks the tool
// call, any other non-zero code is a non-blocking error the model moves past, so
// a sentinel that threw was indistinguishable from one that approved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// OMIT_HOOKS_DIR replays the same payloads against another checkout of the hooks,
// which is how each case below can be shown failing before its fix and passing
// after (the fixture is the payload, not the harness).
const HOOKS = process.env.OMIT_HOOKS_DIR ?? fileURLToPath(new URL('../hooks/', import.meta.url))
// No global config: a developer's git config must not leak into the fixture.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const COMMIT = ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m']

function repo(dirName = 'repo') {
  const base = mkdtempSync(join(tmpdir(), 'omit-hooks-'))
  const dir = join(base, dirName)
  mkdirSync(dir, { recursive: true })
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'ignore'] })
  run(['init', '-q', '.'])
  run([...COMMIT, 'base', '--allow-empty'])
  return { dir, run }
}

const commit = (run, message) => run([...COMMIT, message])

// The hook is spawned from the test's cwd and told where it is by the payload —
// exactly as the harness does it, and the only way the malformed-cwd case below
// can reach a hook that is actually running.
const hook = (name, payload, { env = {} } = {}) =>
  spawnSync('node', [join(HOOKS, name)], { cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify(payload), env: { ...ENV, ...env } })

const edit = (dir, file) => ({ cwd: dir, tool_input: { file_path: file } })
const bash = (dir, command) => ({ cwd: dir, tool_input: { command } })

const ledger = (dir, ...lines) => {
  mkdirSync(join(dir, '.omit'), { recursive: true })
  writeFileSync(join(dir, '.omit', 'receipts.jsonl'), lines.join('\n') + '\n')
}
const draft = (dir, text) => {
  mkdirSync(join(dir, '.omit'), { recursive: true })
  writeFileSync(join(dir, '.omit', 'final-draft.md'), text)
}

// Delete a blob from the object store: git knows the path is in HEAD (so this is
// not "no earlier revision") and cannot produce its contents. It is the
// deterministic version of "the read threw", which is what turned blocking
// verdicts into non-blocking crash exits.
function dropBlob(dir, run, rev) {
  const sha = run(['rev-parse', rev]).trim()
  rmSync(join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)), { force: true })
}

// A key-shaped fixture assembled from fragments: secrets have no override, and
// a literal here would make this file uncommittable by its own scanner.
const SECRET = `const k = "AKIA${'ABCDEFGHIJKLMNOP'}"`

// ---- the exit-code contract ----
// Every payload below is a tool input a hook cannot read. Before the fix each one
// threw out of the hook: node exits 1, the harness reads that as a non-blocking
// error, and the edit or command proceeds.
for (const [name, payload] of [
  ['command-sentinel.mjs', { tool_input: { command: 42 } }],
  ['leak-sentinel.mjs', { tool_input: { command: 42 } }],
  ['dep-sentinel.mjs', { tool_input: { file_path: 42 } }],
  ['hazard-sentinel.mjs', { tool_input: { file_path: 42 } }],
  ['lint-sentinel.mjs', { tool_input: { file_path: 42 } }],
  ['final-draft-gate.mjs', { cwd: 42 }],
]) {
  test(`${name} blocks instead of crashing when it cannot read its input`, () => {
    const r = hook(name, payload)
    assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
  })
}

test('dep-sentinel blocks when git cannot produce the manifest it must compare', () => {
  const { dir, run } = repo()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }))
  run(['add', 'package.json'])
  commit(run, 'manifest')
  dropBlob(dir, run, 'HEAD:package.json')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }))
  const r = hook('dep-sentinel.mjs', edit(dir, join(dir, 'package.json')))
  // Before: `fileAtRevision(...) ?? ''` handed the {failed:true} object to the dep
  // parser, which threw — exit 1, a shrug, and the objection was lost.
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
  assert.match(r.stderr, /could not complete the new-dependency check/)
})

test('hazard-sentinel blocks when git cannot produce the diff it scans', () => {
  const { dir, run } = repo()
  writeFileSync(join(dir, 'a.js'), 'const a = 1\n')
  run(['add', 'a.js'])
  commit(run, 'file')
  dropBlob(dir, run, 'HEAD:a.js')
  writeFileSync(join(dir, 'a.js'), 'const a = 1\nconst b = 2\n')
  const r = hook('hazard-sentinel.mjs', edit(dir, join(dir, 'a.js')))
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
  assert.match(r.stderr, /could not complete the hazard scan/)
})

// ---- A9: the .omit/ exemption is not a substring test ----
test('a checkout directory ending in .omit does not exempt the files inside it', () => {
  const { dir } = repo('proj.omit')
  writeFileSync(join(dir, 'app.js'), `${SECRET}\n`)
  const r = hook('hazard-sentinel.mjs', edit(dir, join(dir, 'app.js')))
  // Before: `file.includes('.omit/')` matched the directory name `proj.omit/`,
  // so every file in this checkout skipped the hazard scan.
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
})

test("only omit's own directory is exempt, compared whole-segment", () => {
  const { dir } = repo()
  mkdirSync(join(dir, '.omit'), { recursive: true })
  writeFileSync(join(dir, '.omit', 'receipts.jsonl'), `${SECRET}\n`)
  assert.equal(hook('hazard-sentinel.mjs', edit(dir, join(dir, '.omit', 'receipts.jsonl'))).status, 0)
  writeFileSync(join(dir, 'notes.omit'), `${SECRET}\n`)
  assert.equal(hook('hazard-sentinel.mjs', edit(dir, join(dir, 'notes.omit'))).status, 2)
})

// ---- E2: the ledger is not executable from a hook by default ----
const execFixture = (dir) => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }))
  ledger(
    dir,
    JSON.stringify({
      claim: 'new-dep',
      rung: 7,
      dep: 'left-pad',
      // A verified-looking `tried` entry whose evidence is a snippet that would
      // run as the developer. The ledger is written by the agent under check.
      tried: [{ claim: 'stdlib', rung: 3, api: 'padSync', run: ['node', '-e', "require('fs').writeFileSync('PWNED','x');console.log('padSync')"] }],
    })
  )
}

test('a hook does not execute ledger snippets by default', () => {
  const { dir } = repo()
  execFixture(dir)
  const r = hook('dep-sentinel.mjs', edit(dir, join(dir, 'package.json')))
  assert.equal(existsSync(join(dir, 'PWNED')), false, 'the hook ran ledger argv as the developer')
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
  // Declining to execute has to be said out loud: a receipt it could not check is
  // not a receipt it verified.
  assert.match(r.stderr, /NOT executed/)
})

test('OMIT_HOOK_EXEC=1 is the opt-in, and OMIT_HOOK_EXEC=0 is not', () => {
  const on = repo()
  execFixture(on.dir)
  hook('dep-sentinel.mjs', edit(on.dir, join(on.dir, 'package.json')), { env: { OMIT_HOOK_EXEC: '1' } })
  assert.equal(existsSync(join(on.dir, 'PWNED')), true, 'the opt-in did not take effect')
  const off = repo()
  execFixture(off.dir)
  hook('dep-sentinel.mjs', edit(off.dir, join(off.dir, 'package.json')), { env: { OMIT_HOOK_EXEC: '0' } })
  assert.equal(existsSync(join(off.dir, 'PWNED')), false, "OMIT_HOOK_EXEC=0 must mean off, like '' and 'false'")
})

// ---- A11: the Final Draft gate is on the report, not on the file ----
test('the Final Draft gate is not satisfied by an empty file', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'a.js'), 'one\ntwo\n')
  draft(dir, '')
  const r = hook('final-draft-gate.mjs', { cwd: dir })
  // Before: a 0-byte draft with a newer mtime passed, so the session could end
  // with an edited tree and no net report at all.
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
  assert.match(r.stderr, /files touched/)
})

test('an honest Final Draft passes', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'a.js'), 'one\ntwo\nthree\n')
  draft(dir, 'files touched: 1\nlines: +3 −0\nnew dependencies: 0\n\nCut: a speculative option.\n')
  assert.equal(hook('final-draft-gate.mjs', { cwd: dir }).status, 0)
})

test('a Final Draft whose line count the tree contradicts is refused', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'a.js'), 'one\ntwo\nthree\n')
  draft(dir, 'files touched: 1\nlines: +300 −0\nnew dependencies: 0\n')
  const r = hook('final-draft-gate.mjs', { cwd: dir })
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
  assert.match(r.stderr, /the tree has \+3 −0/)
})

test('a Final Draft reporting zero new dependencies for a manifest that gained one is refused', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }))
  draft(dir, 'files touched: 1\nlines: +1 −0\nnew dependencies: 0\n')
  const r = hook('final-draft-gate.mjs', { cwd: dir })
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
  assert.match(r.stderr, /new dependencies: draft says 0, the tree has 1/)
})

test('a Final Draft older than the newest edit is refused', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'a.js'), 'one\ntwo\n')
  draft(dir, 'files touched: 1\nlines: +2 −0\nnew dependencies: 0\n')
  const later = new Date(Date.now() + 5000)
  utimesSync(join(dir, 'a.js'), later, later)
  const r = hook('final-draft-gate.mjs', { cwd: dir })
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
  assert.match(r.stderr, /older than the newest edit/)
})

// `omit audit` counts omit's own tracked ledger files; the gate counts the change.
// A draft that pasted audit's verdict is reporting the tree accurately, so it
// passes with a note rather than being sent back over omit's own bookkeeping.
test("a Final Draft using omit audit's counts passes, with a note", () => {
  const { dir, run } = repo()
  mkdirSync(join(dir, '.omit'), { recursive: true })
  writeFileSync(join(dir, '.omit', 'receipts.jsonl'), '')
  run(['add', '.omit/receipts.jsonl'])
  commit(run, 'ledger')
  writeFileSync(join(dir, 'a.js'), 'one\ntwo\n')
  writeFileSync(join(dir, '.omit', 'receipts.jsonl'), '{}\n')
  draft(dir, 'files touched: 2\nlines: +3 −0\nnew dependencies: 0\n')
  const r = hook('final-draft-gate.mjs', { cwd: dir })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /omit's own tracked files/)
})

// The gate recomputes the change set that `omit audit` already computes, and
// compares the agent's report against it. Two implementations that must agree is
// a drift risk, so this pins them to each other with the real CLI rather than
// hand-written numbers: a draft pasting audit's ACTUAL verdict has to pass. If
// either counting changes, this fails loudly instead of the gate quietly
// refusing honest reports.
test("a Final Draft pasting omit audit's real verdict passes", () => {
  const { dir, run } = repo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'util.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: {} }))
  run(['add', '-A'])
  commit(run, 'base')
  // A tracked edit plus an untracked file: the two paths disagree most on
  // untracked content, which git's diff cannot see at all.
  writeFileSync(join(dir, 'src', 'util.js'), 'export const a = 1\nexport const b = 2\n')
  writeFileSync(join(dir, 'notes.md'), 'one\ntwo\nthree\n')

  const cli = fileURLToPath(new URL('../bin/omit.mjs', import.meta.url))
  const verdict = spawnSync('node', [cli, 'audit'], { cwd: dir, encoding: 'utf8', env: ENV })
  assert.equal(verdict.status, 0, verdict.stderr)
  draft(dir, `# Final Draft\n\n${verdict.stdout}`)

  const r = hook('final-draft-gate.mjs', { cwd: dir })
  assert.equal(r.status, 0, `the gate refused a draft pasting audit's own verdict:\n${r.stderr}`)
})

// ---- A6: tool-event coverage ----
test('hooks.json routes the file sentinels to NotebookEdit and to Bash', () => {
  const doc = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8'))
  const covers = (tool, script) =>
    doc.hooks.PostToolUse.some((g) => new RegExp(`^(?:${g.matcher})$`).test(tool) && (g.hooks ?? []).some((h) => h.command.includes(script)))
  assert.ok(covers('Edit', 'hazard-sentinel.mjs'))
  assert.ok(covers('NotebookEdit', 'hazard-sentinel.mjs'), 'a notebook cell reaches no sentinel')
  assert.ok(covers('Bash', 'hazard-sentinel.mjs'), 'cat >, tee and sed -i reach no sentinel')
  assert.ok(covers('Bash', 'dep-sentinel.mjs'), 'npm pkg set rewrites package.json invisibly')
})

test('a notebook cell written by NotebookEdit is scanned', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'nb.ipynb'), '{"cells":[]}\n')
  const r = hook('hazard-sentinel.mjs', { cwd: dir, tool_input: { notebook_path: join(dir, 'nb.ipynb'), cell_id: 'c1', new_source: SECRET, edit_mode: 'replace' } })
  // Before: the hook only knew `file_path`, which NotebookEdit does not send, so
  // the cell reached no sentinel at all.
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
})

test('a manifest rewritten by Bash is checked like any other edit', () => {
  const { dir, run } = repo()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }))
  run(['add', 'package.json'])
  commit(run, 'manifest')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }))
  const r = hook('dep-sentinel.mjs', bash(dir, 'npm pkg set dependencies.left-pad=^1.3.0'))
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
})

test('a file written with a redirect is scanned', () => {
  const { dir } = repo()
  const r = hook('hazard-sentinel.mjs', bash(dir, `cat > config.js <<'EOF'\n${SECRET}\nEOF`))
  assert.equal(r.status, 2, `expected a blocking exit 2, got ${r.status}: ${r.stderr}`)
})

// A Bash matcher fires on EVERY Bash call, so the sentinels have to decide from
// the command text alone. The shim makes "did it spawn git" observable: a marker
// file appears the moment the hook reaches for a subprocess.
function shimGit() {
  const bin = mkdtempSync(join(tmpdir(), 'omit-shim-'))
  const marker = join(bin, 'git-called')
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf x >> ${JSON.stringify(marker)}\nexec ${real} "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  return { path: `${bin}:${process.env.PATH}`, marker }
}

test('an unrelated Bash command costs no subprocess', () => {
  const { dir } = repo()
  const shim = shimGit()
  assert.equal(hook('dep-sentinel.mjs', bash(dir, 'npm run build'), { env: { PATH: shim.path } }).status, 0)
  assert.equal(hook('hazard-sentinel.mjs', bash(dir, 'ls -la'), { env: { PATH: shim.path } }).status, 0)
  assert.equal(existsSync(shim.marker), false, 'the hook spawned git for a command that writes nothing')

  // The same shim, once a manifest is plausibly in play, proves the check below
  // the guard does reach git.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }))
  assert.equal(hook('dep-sentinel.mjs', bash(dir, 'npm pkg set name=y'), { env: { PATH: shim.path } }).status, 0)
  assert.equal(existsSync(shim.marker), true)
})

// ---- the earlier verdicts still hold ----
test('a new dependency still blocks, and a verified receipt still clears it', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }))
  assert.equal(hook('dep-sentinel.mjs', edit(dir, join(dir, 'package.json'))).status, 2)

  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const padTo = (s) => s\n')
  // A `tried` entry the checker can verify: a symbol genuinely absent from the
  // tracked tree, so the omission it records really does not hold.
  ledger(dir, JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'left-pad', tried: [{ rung: 2, absent: 'formatPad' }] }))
  assert.equal(hook('dep-sentinel.mjs', edit(dir, join(dir, 'package.json'))).status, 0)
})

test('a clean tree with no draft still ends the session', () => {
  const { dir } = repo()
  assert.equal(hook('final-draft-gate.mjs', { cwd: dir }).status, 0)
})

test('OMIT_OFF disables every hook', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'app.js'), `${SECRET}\n`)
  const r = hook('hazard-sentinel.mjs', edit(dir, join(dir, 'app.js')), { env: { OMIT_OFF: '1' } })
  assert.equal(r.status, 0, r.stderr)
})
