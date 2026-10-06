// Ribhu's side of the hook contract, reproduced: it reads `.ribhu/hooks.json`,
// picks entries whose `matcher` regex matches the tool name, runs each
// `command` with `sh -c` and the event payload on stdin, and treats exit 2 as
// a block whose reason is stderr. These tests install the hooks, then fire
// them exactly that way with payloads in Ribhu's shape, so what is judged is
// the file omit writes and the commands in it, not the adapter in isolation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/omit.mjs', import.meta.url))
const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url))
// No global config: a developer's git config must not leak into the fixture.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', OMIT_OFF: '' }
const COMMIT = ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m']
// Assembled, so this file does not itself carry something shaped like a key.
const FAKE_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'
// Every tool Ribhu registers (crates/ribhu-tools), for checking what a matcher selects.
const RIBHU_TOOLS = 'ast_edit bash browser code_query code_rename computer diagnostics edit glob grep ls multi_edit pdf read repo_map skill todo_write web_search web write'.split(' ')

function repo() {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'omit-ribhu-'))), 'repo')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir, env: ENV })
  writeFileSync(join(dir, 'package.json'), '{"name":"t","dependencies":{}}\n')
  writeFileSync(join(dir, 'clean.py'), 'x = 1\n')
  execFileSync('git', ['add', '.'], { cwd: dir, env: ENV })
  execFileSync('git', [...COMMIT, 'init'], { cwd: dir, env: ENV })
  const installed = spawnSync(process.execPath, [BIN, 'hook', 'install', 'ribhu'], { cwd: dir, env: ENV, encoding: 'utf8' })
  assert.equal(installed.status, 0, installed.stderr)
  return dir
}

const hooksOf = (dir) => JSON.parse(readFileSync(join(dir, '.ribhu', 'hooks.json'), 'utf8')).hooks

// What Ribhu does for one event: every entry whose matcher selects the tool
// runs, and the first exit 2 is the block.
function fire(dir, event, payload) {
  const results = []
  for (const hook of hooksOf(dir)[event] ?? []) {
    if (hook.matcher && !new RegExp(hook.matcher).test(payload.tool)) continue
    const r = spawnSync('sh', ['-c', hook.command], { cwd: dir, env: ENV, encoding: 'utf8', input: JSON.stringify({ event, cwd: dir, ...payload }) })
    results.push({ sentinel: hook.command.split(' ').pop(), status: r.status, stdout: r.stdout, stderr: r.stderr })
  }
  return { results, block: results.find((r) => r.status === 2) }
}

test('the installed file is in the shape Ribhu loads: a flat list of { matcher, command } per event', () => {
  const dir = repo()
  const hooks = hooksOf(dir)
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'Stop'])
  for (const list of Object.values(hooks)) {
    for (const hook of list) {
      // Ribhu's HookDecl: command, and optionally matcher and timeoutMs. A
      // nested `hooks: [...]` group, which is what Codex's file holds, is not one.
      assert.deepEqual(Object.keys(hook).filter((k) => !['matcher', 'command', 'timeoutMs'].includes(k)), [])
      assert.equal(typeof hook.command, 'string')
      assert.match(hook.command, /ribhu-adapter\.mjs" [a-z-]+$/)
    }
  }
  // Ribhu caps a hook at sixty seconds and defaults to ten.
  assert.deepEqual(hooks.PostToolUse.filter((h) => h.timeoutMs).map((h) => h.timeoutMs), [60000])
})

test('each matcher selects the Ribhu tools it is meant to, and no others', () => {
  const selected = {}
  const hooks = hooksOf(repo())
  for (const [event, list] of Object.entries(hooks)) {
    for (const hook of list) {
      selected[`${event} ${hook.command.split(' ').pop()}`] = hook.matcher ? RIBHU_TOOLS.filter((t) => new RegExp(hook.matcher).test(t)) : 'every turn'
    }
  }
  const files = ['ast_edit', 'edit', 'multi_edit', 'write']
  assert.deepEqual(selected, {
    'PreToolUse command-sentinel': ['bash'],
    'PreToolUse leak-sentinel': ['bash'],
    // todo_write is not a file write, and an unanchored `write` would catch it.
    'PostToolUse dep-sentinel': ['ast_edit', 'bash', 'edit', 'multi_edit', 'write'],
    'PostToolUse hazard-sentinel': ['ast_edit', 'bash', 'edit', 'multi_edit', 'write'],
    'PostToolUse lint-sentinel': files,
    'Stop final-draft-gate': 'every turn',
  })
})

test('installing again changes nothing, and someone else\'s hooks are kept', () => {
  const dir = repo()
  const path = join(dir, '.ribhu', 'hooks.json')
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  doc.hooks.PreToolUse.unshift({ matcher: 'bash|edit', command: './scripts/guard.sh' })
  doc.hooks.UserPromptSubmit = [{ command: 'echo hi' }]
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
  const before = readFileSync(path, 'utf8')
  assert.equal(spawnSync(process.execPath, [BIN, 'hook', 'install', 'ribhu'], { cwd: dir, env: ENV }).status, 0)
  assert.equal(readFileSync(path, 'utf8'), before)

  // A file that cannot be read is refused, not replaced.
  writeFileSync(path, '{ not json')
  const refused = spawnSync(process.execPath, [BIN, 'hook', 'install', 'ribhu'], { cwd: dir, env: ENV, encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.equal(readFileSync(path, 'utf8'), '{ not json')
})

test('before bash: a disaster and a secret leak are blocked with their reason, an ordinary command is not', () => {
  const dir = repo()
  const disaster = fire(dir, 'PreToolUse', { tool: 'bash', input: { command: 'rm -rf ~' } })
  assert.equal(disaster.block?.sentinel, 'command-sentinel')
  assert.match(disaster.block.stderr, /protected/)

  const leak = fire(dir, 'PreToolUse', { tool: 'bash', input: { command: 'cat .env' } })
  assert.equal(leak.block?.sentinel, 'leak-sentinel')

  const ordinary = fire(dir, 'PreToolUse', { tool: 'bash', input: { command: 'ls -la' } })
  assert.deepEqual(ordinary.results.map((r) => [r.sentinel, r.status]), [['command-sentinel', 0], ['leak-sentinel', 0]])
  // Ribhu reads a hook's stdout as a rewrite of the tool's input: there must be none.
  assert.deepEqual(ordinary.results.map((r) => r.stdout), ['', ''])

  // A tool no matcher selects reaches no hook at all.
  assert.deepEqual(fire(dir, 'PreToolUse', { tool: 'read', input: { path: 'clean.py' } }).results, [])
})

test('after a file tool: `input.path` reaches the sentinels as the file they check', () => {
  const dir = repo()
  writeFileSync(join(dir, 'creds.py'), `aws_access_key_id = "${FAKE_KEY}"\n`)
  for (const tool of ['write', 'edit', 'multi_edit', 'ast_edit']) {
    const hit = fire(dir, 'PostToolUse', { tool, input: { path: 'creds.py' }, output: 'ok', isError: false })
    assert.equal(hit.block?.sentinel, 'hazard-sentinel', tool)
    assert.match(hit.block.stderr, /aws-access-key/)
  }
  const clean = fire(dir, 'PostToolUse', { tool: 'edit', input: { path: 'clean.py' }, output: 'ok', isError: false })
  assert.equal(clean.block, undefined)
  assert.deepEqual(clean.results.map((r) => r.sentinel), ['dep-sentinel', 'hazard-sentinel', 'lint-sentinel'])

  // A dependency added with no receipt is objected to, as it is under Claude Code.
  writeFileSync(join(dir, 'package.json'), '{"name":"t","dependencies":{"left-pad":"1.0.0"}}\n')
  const dep = fire(dir, 'PostToolUse', { tool: 'edit', input: { path: 'package.json' }, output: 'ok', isError: false })
  assert.equal(dep.block?.sentinel, 'dep-sentinel')
  assert.match(dep.block.stderr, /left-pad/)
})

test('on Stop: an edited tree with no Final Draft sends the agent back in', () => {
  const dir = repo()
  writeFileSync(join(dir, 'clean.py'), 'x = 2\n')
  const stop = fire(dir, 'Stop', { turn: 3 })
  assert.equal(stop.block?.sentinel, 'final-draft-gate')
  assert.match(stop.block.stderr, /final-draft\.md/)
})

// The adapter adds nothing of its own to a verdict. Whatever a sentinel makes
// of a payload it cannot read, the adapter hands on unchanged.
test('the adapter never changes a verdict, and runs only the six sentinels', () => {
  const dir = repo()
  const adapter = (name, input) => spawnSync(process.execPath, [join(HOOKS, 'ribhu-adapter.mjs'), name], { cwd: dir, env: ENV, encoding: 'utf8', input })
  for (const raw of ['{ not json', 'null', '"text"', '{"input":"not an object"}', '']) {
    const direct = spawnSync(process.execPath, [join(HOOKS, 'command-sentinel.mjs')], { cwd: dir, env: ENV, encoding: 'utf8', input: raw })
    const through = adapter('command-sentinel', raw)
    assert.deepEqual([through.status, through.stderr], [direct.status, direct.stderr], JSON.stringify(raw))
  }
  // The name comes from a file a cloned repo can carry: it is never a path.
  for (const name of ['../../etc/passwd', 'ribhu-adapter', 'hazard-sentinel.mjs', undefined]) {
    const r = adapter(name ?? '', '{}')
    assert.equal(r.status, 1, String(name))
    assert.match(r.stderr, /has no sentinel called/)
  }
})
