import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { detectLinters, execDisabled, lintFiles, spawnPlan } from '../lib/lint.mjs'

// A stub ecosystem on PATH, never a real install: the repo under test is a temp
// dir holding a config file and nothing else, and `npx` is a shell script that
// records the argv it was handed. No test here needs node_modules.
function repo({ stub = 'npx', exit = 0, stdout = '', stderr = '', config = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omit-lint-'))
  const bin = join(dir, 'bin')
  const log = join(dir, 'calls.log')
  mkdirSync(bin)
  if (stub) {
    const lines = ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`]
    if (stdout) lines.push(`printf '%s\\n' '${stdout}'`)
    if (stderr) lines.push(`printf '%s\\n' '${stderr}' >&2`)
    lines.push(`exit ${exit}`)
    writeFileSync(join(bin, stub), lines.join('\n') + '\n')
    chmodSync(join(bin, stub), 0o755)
  }
  // The config a PR author controls — and, for eslint, arbitrary JavaScript.
  if (config) writeFileSync(join(dir, 'eslint.config.js'), 'export default []\n')
  return { dir, bin, log }
}

// PATH is how the bridge finds `npx`, so tests scope it; nothing else runs
// concurrently in this file.
function scope(bin, fn, { noExec } = {}) {
  const path = process.env.PATH
  const was = process.env.OMIT_NO_EXEC
  process.env.PATH = bin
  if (noExec === undefined) delete process.env.OMIT_NO_EXEC
  else process.env.OMIT_NO_EXEC = noExec
  try {
    return fn()
  } finally {
    process.env.PATH = path
    if (was === undefined) delete process.env.OMIT_NO_EXEC
    else process.env.OMIT_NO_EXEC = was
  }
}

// ---- A7: "no linter configured" for a repo that has one ----

// The agent controls this: `rm -rf node_modules` removed the binary, and the old
// `continue` collapsed "configured but unrunnable" into "nothing to say" — which
// the renderer turned into a claim about the repo that simply wasn't true.
test('a configured linter with nothing to run it is reported, not swallowed', () => {
  const { dir, bin } = repo({ stub: null })
  const r = scope(bin, () => lintFiles(dir, ['a.ts']))
  assert.equal(r.length, 1, 'an empty result is exactly what renders as "no linter configured"')
  assert.equal(r[0].linter, 'eslint')
  assert.equal(r[0].status, 'unavailable')
  assert.equal(r[0].ok, true, 'nothing failed — the gate and the edit hook only ask whether anything is wrong')
  assert.deepEqual(detectLinters(dir).map((l) => l.name), ['eslint'], 'the config is still detected: that disagreement is the bug')
})

test('a binary that is present but not installed is unavailable, not clean', () => {
  const { dir, bin } = repo({ exit: 1, stderr: 'npm error could not determine executable to run' })
  const r = scope(bin, () => lintFiles(dir, ['a.ts']))
  assert.equal(r[0].status, 'unavailable')
})

test('a linter that ran and objected is a failure, not an unavailability', () => {
  const { dir, bin } = repo({ exit: 1, stdout: 'a.ts:1:1  error  no-unused-vars' })
  const r = scope(bin, () => lintFiles(dir, ['a.ts']))
  assert.deepEqual(r.map((x) => [x.linter, x.status, x.ok]), [['eslint', 'fail', false]])
  assert.match(r[0].output, /no-unused-vars/)
})

test('only a run that passed reads as ok', () => {
  const { dir, bin, log } = repo({ exit: 0, stdout: 'checked 1 file' })
  const r = scope(bin, () => lintFiles(dir, ['a.ts']))
  assert.deepEqual(r.map((x) => [x.status, x.ok]), [['ok', true]])
  assert.equal(readFileSync(log, 'utf8').trim(), '--no-install eslint a.ts')
})

test('a repo with no config reports nothing at all', () => {
  const { dir, bin } = repo({ config: false })
  assert.deepEqual(detectLinters(dir), [])
  assert.deepEqual(scope(bin, () => lintFiles(dir, ['a.ts'])), [])
})

// ---- E4: the lint path ran PR-supplied code whatever OMIT_NO_EXEC said ----

test('OMIT_NO_EXEC stops the lint bridge from spawning anything', () => {
  const { dir, bin, log } = repo({ exit: 0 })
  const r = scope(bin, () => lintFiles(dir, ['a.ts']), { noExec: '1' })
  assert.equal(existsSync(log), false, 'the linter was spawned — eslint.config.js is arbitrary JS from the PR, so this ran PR code on the runner')
  assert.deepEqual(r.map((x) => [x.linter, x.status, x.ok]), [['eslint', 'not-run', true]])
})

test('execDisabled is off only by an explicit off-value', () => {
  const at = (v) => {
    if (v === undefined) delete process.env.OMIT_NO_EXEC
    else process.env.OMIT_NO_EXEC = v
    try {
      return execDisabled()
    } finally {
      delete process.env.OMIT_NO_EXEC
    }
  }
  for (const v of [undefined, '', '0', 'false']) assert.equal(at(v), false, `${v} means execute`)
  // Anything unrecognized disables: a flag misspelled into existence must not open the door.
  for (const v of ['1', 'true', 'yes', 'no', 'FALSE', ' ']) assert.equal(at(v), true, `${v} means do not`)
})

// ---- E5: argv handed to a shell, where it stops being argv ----

// The mechanism the finding rests on, stated where it can be watched: `shell:
// true` concatenates the array into a command line, so one element becomes two
// commands. Confirmed here; the win32 end-to-end was not — no Windows host.
test('shell:true re-parses one argv element into two commands', () => {
  const arg = 'a;echo INJECTED'
  assert.equal(spawnSync('echo', [arg], { shell: true, encoding: 'utf8' }).stdout.trim(), 'a\nINJECTED')
  assert.equal(spawnSync('echo', [arg], { shell: false, encoding: 'utf8' }).stdout.trim(), arg)
})

test('a filename with shell punctuation reaches the linter as one argument', () => {
  const { dir, bin, log } = repo({ exit: 0 })
  const name = 'a;touch PWNED;x.ts'
  writeFileSync(join(dir, name), '')
  const r = scope(bin, () => lintFiles(dir, [name]))
  assert.equal(existsSync(join(dir, 'PWNED')), false, 'the filename was executed as a command')
  assert.equal(readFileSync(log, 'utf8').trim(), `--no-install eslint ${name}`)
  assert.equal(r[0].status, 'ok')
})

test('a Windows .cmd shim gets our own verbatim line, never a shell:', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omit-lint-'))
  writeFileSync(join(dir, 'npx.CMD'), '@echo off\r\n')
  writeFileSync(join(dir, 'ruff.EXE'), '')
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD', ComSpec: 'cmd.exe' }

  // cmd.exe re-expands all of these inside what looks like a quoted argument,
  // so the whole run is refused rather than quoted and hoped for.
  for (const name of ['a&b.js', 'a|b.js', 'a%b.js', 'a"b.js', 'a!b.js', 'a^b.js', 'a>b.js', 'a\nb.js', 'dir\\']) {
    assert.equal(spawnPlan('npx', ['--no-install', 'eslint', name], 'win32', env), null, `${JSON.stringify(name)} must be refused`)
  }

  const plan = spawnPlan('npx', ['--no-install', 'eslint', 'src/my file.ts'], 'win32', env)
  assert.equal(plan.shell, false)
  assert.equal(plan.verbatim, true, 'the line is ours: the OS must not quote it a second time')
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(plan.args.length, 4, 'one payload, so cmd /s strips exactly the quotes around the whole line')
  assert.match(plan.args[3], /^".*npx\.CMD --no-install eslint "src\/my file\.ts""$/)

  // An .exe needs no shell at all, so it is spawned directly — the shim is
  // resolved explicitly instead of being left to a shell to find.
  const exe = spawnPlan('ruff', ['check', 'a.py'], 'win32', env)
  assert.deepEqual([exe.cmd, exe.args, exe.shell], [join(dir, 'ruff.EXE'), ['check', 'a.py'], false])
})

test('no platform is ever asked to re-parse argv through a shell', () => {
  for (const platform of ['darwin', 'linux']) {
    const plan = spawnPlan('ruff', ['check', 'src/a.ts'], platform, { PATH: '' })
    assert.deepEqual([plan.cmd, plan.args], ['ruff', ['check', 'src/a.ts']], `${platform} passes argv through as argv`)
    assert.equal(plan.shell, false, `${platform} must not use a shell`)
  }
  // win32 with no shim still goes through cmd.exe, but never through a shell:
  // the line is ours, and every argument in it was checked before it was built.
  const win = spawnPlan('ruff', ['check', 'src/a.ts'], 'win32', { PATH: '', PATHEXT: '.CMD', ComSpec: 'cmd.exe' })
  assert.equal(win.shell, false)
  assert.deepEqual([win.verbatim, win.args.slice(0, 3)], [true, ['/d', '/s', '/c']])
})
