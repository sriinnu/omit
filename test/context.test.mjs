import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readWarnings, preview, existingSessionDir, repeatCount } from '../lib/context.mjs'
import { doctor } from '../lib/doctor.mjs'

const cli = fileURLToPath(new URL('../bin/omit.mjs', import.meta.url))
const temp = () => mkdtempSync(join(tmpdir(), 'omit-context-test-'))
const run = (args, cwd, input, env = {}) => spawnSync(process.execPath, [cli, ...args], {
  cwd, encoding: 'utf8', input: JSON.stringify(input),
  env: { ...process.env, OMIT_OFF: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
})
const payload = (cwd, text, command = 'test-command') => ({ cwd, session_id: 'synthetic', tool_name: 'Bash', hook_event_name: 'PostToolUse', tool_input: { command }, tool_response: text })

test('scope warnings stay advisory and recognize targeted reads', () => {
  assert.ok(readWarnings('cat huge.txt').length)
  assert.ok(readWarnings('rg keyword node_modules').length)
  assert.deepEqual(readWarnings("rg -n keyword src | head -20"), [])
  const cwd = temp()
  const r = run(['context'], cwd, { ...payload(cwd, ''), hook_event_name: 'PreToolUse', tool_input: { command: 'cat huge.txt' } })
  assert.equal(r.status, 0)
  assert.ok(JSON.parse(r.stdout).systemMessage)
  assert.equal(JSON.parse(r.stdout).decision, undefined)
})

test('context output preserves full text privately and returns head/tail preview', () => {
  const cwd = temp()
  const text = 'START' + 'x'.repeat(8000) + 'ERROR END'
  const r = run(['context'], cwd, payload(cwd, text))
  assert.equal(r.status, 0, r.stderr)
  const result = JSON.parse(r.stdout)
  assert.equal(result.decision, 'block')
  assert.match(result.reason, /^START/)
  assert.match(result.reason, /ERROR END$/)
  const path = /full output: ([^\n]+)\]/.exec(result.reason)[1]
  assert.equal(readFileSync(path, 'utf8'), text)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('small or structured results are never replaced; disabled hooks stay silent', () => {
  const cwd = temp()
  for (const text of ['short', { output: 'x'.repeat(9000), exit_code: 1 }]) {
    const r = run(['context'], cwd, payload(cwd, text))
    assert.equal(r.stdout, '')
    assert.equal(r.status, 0)
  }
  assert.equal(run(['context'], cwd, payload(cwd, 'x'.repeat(9000)), { OMIT_OFF: '1' }).stdout, '')
  assert.equal(preview('small'), null)
  assert.match(preview('x'.repeat(7000) + '\nERROR middle\n' + 'x'.repeat(7000)).diagnostics, /ERROR middle/)
})

test('only the third consecutive identical command and result warns', () => {
  const cwd = temp()
  for (let i = 1; i <= 4; i++) {
    const r = run(['context'], cwd, payload(cwd, 'same output'))
    assert.equal(Boolean(r.stdout), i === 3)
  }
  assert.equal(run(['context'], cwd, payload(cwd, 'changed output')).stdout, '')
  assert.equal(run(['context'], cwd, payload(cwd, 'changed output', 'different command')).stdout, '')
})

test('bad budgets and malformed input preserve original results with a diagnostic', () => {
  const cwd = temp()
  const r = run(['context'], cwd, payload(cwd, 'x'.repeat(9000)), { OMIT_OUTPUT_CHARS: 'NaN' })
  assert.equal(JSON.parse(r.stdout).decision, undefined)
  assert.match(JSON.parse(r.stdout).systemMessage, /not replaced/)
})

test('repeat state rejects symlinks instead of reading a target', () => {
  const cwd = temp()
  const dir = existingSessionDir(cwd, 'unique')
  const target = join(cwd, 'target')
  writeFileSync(target, '{}')
  symlinkSync(target, join(dir, 'repeat.json'))
  assert.throws(() => repeatCount(dir, 'hash'), /unsafe repeat state/)
  assert.equal(readFileSync(target, 'utf8'), '{}')
})

test('doctor finds missing scripts, duplicate registrations and legacy tool names without executing hooks', () => {
  const cwd = temp()
  const global = temp()
  const script = join(cwd, 'legacy.py')
  writeFileSync(script, 'TOOL_NAMES = {"exec", "shell"}\nraise Exception("must not execute")\n')
  const hook = { type: 'command', command: `python3 "${script}"` }
  writeFileSync(join(global, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [hook, hook, { type: 'command', command: 'node missing.mjs' }] }] } }))
  const report = doctor(cwd, global)
  assert.equal(report.liveDelivery, 'unverified')
  assert.ok(report.findings.some(f => /omits Bash/.test(f.message)))
  assert.ok(report.findings.some(f => /duplicate/.test(f.message)))
  assert.ok(report.findings.some(f => f.level === 'error' && /missing/.test(f.message)))
})

test('doctor handles corrupt configuration and reports JSON with failing exit status', () => {
  const cwd = temp()
  const global = temp()
  writeFileSync(join(global, 'hooks.json'), '{')
  const r = run(['doctor', '--json'], cwd, undefined, { CODEX_HOME: global })
  assert.equal(r.status, 1)
  assert.ok(JSON.parse(r.stdout).findings.some(f => f.level === 'error'))
})

test('context hooks install for either host and discoverable skill copies without overwrite', () => {
  for (const host of ['codex', 'claude']) {
    const cwd = temp()
    const r = run(['hook', 'install', host, '--context'], cwd)
    assert.equal(r.status, 0, r.stderr)
    const path = join(cwd, `.${host}`, host === 'claude' ? 'settings.json' : 'hooks.json')
    const first = readFileSync(path, 'utf8')
    const doc = JSON.parse(first)
    for (const event of ['PreToolUse', 'PostToolUse']) assert.ok(doc.hooks[event].some(g => g.hooks.some(h => h.command.includes('context-sentinel.mjs'))))
    assert.equal(run(['hook', 'install', host, '--context'], cwd).status, 0)
    assert.equal(readFileSync(path, 'utf8'), first)
    assert.equal(run(['init', 'skill'], cwd).status, 0)
    const skill = join(cwd, '.agents/skills/omit/SKILL.md')
    assert.match(readFileSync(skill, 'utf8'), /name: omit/)
    writeFileSync(skill, 'user content')
    run(['init', 'skill'], cwd)
    assert.equal(readFileSync(skill, 'utf8'), 'user content')
  }
})
