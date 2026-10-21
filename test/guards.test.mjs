// The guards added around the sentinels: TLS bypasses, hook tampering, Read
// and Grep leaks, the enforcement mode, the session baseline, and the CLI
// entry points that hooks files call. Judged by exit code, as the harness does.
//
// TLS-bypass and secret-shaped strings are assembled with j(): written whole,
// this file would be flagged by the scan it tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTls } from '../lib/tls.mjs'
import { findHazards } from '../lib/hazards.mjs'
import { assessCommand } from '../lib/danger.mjs'
import { verifyLedger } from '../lib/receipts.mjs'
import { doctor } from '../lib/doctor.mjs'
import { writeMode } from '../lib/mode.mjs'
import { addedDeps, isManifest } from '../lib/deps.mjs'

const BIN = fileURLToPath(new URL('../bin/omit.mjs', import.meta.url))
const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url))
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', OMIT_OFF: '', OMIT_MODE: '' }
const COMMIT = ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m']
const j = (...parts) => parts.join('')

function repo() {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'omit-guards-'))), 'repo')
  mkdirSync(dir, { recursive: true })
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV })
  run(['init', '-q'])
  writeFileSync(join(dir, 'package.json'), '{"name":"t","dependencies":{}}\n')
  run(['add', '.'])
  run([...COMMIT, 'init'])
  return { dir, run }
}

const hook = (name, payload, env = {}) =>
  spawnSync(process.execPath, [join(HOOKS, `${name}.mjs`)], { encoding: 'utf8', input: JSON.stringify(payload), env: { ...ENV, ...env } })
const cli = (dir, args, input) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: ENV, input })

test('TLS bypasses are found in commands and code, CA-bundle fixes are not', () => {
  for (const bad of [
    j('NODE_TLS_', 'REJECT_UNAUTHORIZED=0 npm install'),
    j('curl -', 'k https://x'),
    j('curl --in', 'secure https://x'),
    j('wget --no-check-', 'certificate https://x'),
    j('npm config set strict-', 'ssl false'),
    j('git config --global http.ssl', 'Verify false'),
    j('pip install --trusted', '-host pypi.org x'),
    j('requests.get(u, verify', '=False)'),
    j('{ rejectUnauth', 'orized: false }'),
  ]) assert.ok(findTls(bad).length, bad)
  for (const good of ['NODE_EXTRA_CA_CERTS=/ca.pem npm install', 'curl --cacert /ca.pem https://x', 'curl -sSL https://x', 'npm config set cafile /ca.pem', j('NODE_TLS_', 'REJECT_UNAUTHORIZED=1')]) {
    assert.deepEqual(findTls(good), [], good)
  }
  // A reviewed line is suppressible in code, unlike a secret.
  assert.deepEqual(findHazards([j('agent = https.Agent({ rejectUnauth', 'orized: false }) // omit-allow: local test CA')]), [])
})

test('the command sentinel blocks a TLS bypass in every mode and says how to trust the CA', () => {
  const { dir } = repo()
  for (const mode of ['redline', 'margin', 'off']) {
    const r = hook('command-sentinel', { cwd: dir, tool_input: { command: j('curl -', 'k https://example.com') } }, { OMIT_MODE: mode })
    assert.equal(r.status, 2, mode)
    assert.match(r.stderr, /--cacert/)
  }
})

test('destructive git commands, hook bypasses, xargs and bare find deletes are blocked', () => {
  const blocked = (cmd) => assert.ok(assessCommand(cmd).length > 0, `expected blocked: ${cmd}`)
  const allowed = (cmd) => assert.deepEqual(assessCommand(cmd), [], `expected allowed: ${cmd}`)
  blocked('git clean -fdx')
  blocked('git reset --hard HEAD~1')
  blocked('git checkout -- .')
  blocked('git restore .')
  blocked('git push --force origin main')
  blocked('git commit --no-verify -m x')
  blocked('git commit -nm x')
  blocked('git config core.hooksPath /dev/null')
  blocked('git ls-files | xargs rm -rf')
  blocked('find . -delete')
  allowed('git clean -n')
  allowed('git restore --staged .')
  allowed('git push --force-with-lease')
  allowed('git commit -m "no-verify in a message"')
  allowed('find . -name "*.tmp" -delete')
  allowed('git status')
})

test('tamper: the agent cannot set the mode or strip omit from a hooks file', () => {
  const { dir } = repo()
  mkdirSync(join(dir, '.claude'), { recursive: true })
  const settings = join(dir, '.claude', 'settings.json')
  const doc = { permissions: { allow: [] }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/x/hooks/final-draft-gate.mjs"' }] }] } }
  writeFileSync(settings, JSON.stringify(doc, null, 2))
  const current = readFileSync(settings, 'utf8')

  const blocks = (ti, name = 'Bash') => hook('tamper-sentinel', { cwd: dir, tool_name: name, tool_input: ti }).status
  assert.equal(blocks({ file_path: join(dir, '.omit', 'mode'), content: 'off\n' }, 'Write'), 2)
  assert.equal(blocks({ command: 'npx omit mode off' }), 2)
  assert.equal(blocks({ command: 'echo off > .omit/mode' }), 2)
  assert.equal(blocks({ file_path: settings, content: '{"hooks":{}}' }, 'Write'), 2, 'dropping the Stop gate')
  assert.equal(blocks({ file_path: settings, old_string: 'final-draft-gate', new_string: 'nothing' }, 'Edit'), 2)
  assert.equal(blocks({ command: 'sed -i d .claude/settings.json' }), 2)
  assert.equal(hook('tamper-sentinel', { cwd: dir, tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Delete File: .claude/settings.json\n*** End Patch` } }).status, 2)

  // Edits that keep omit's hooks, and reads, pass.
  assert.equal(blocks({ file_path: settings, old_string: '"allow": []', new_string: '"allow": ["Bash(ls)"]' }, 'Edit'), 0)
  assert.equal(blocks({ file_path: settings, content: current.replace('"allow": []', '"allow": ["x"]') }, 'Write'), 0)
  assert.equal(blocks({ command: 'cat .claude/settings.json' }), 0)
  assert.equal(blocks({ command: 'omit mode' }), 0, 'reading the mode is fine')
  assert.equal(blocks({ file_path: join(dir, 'src.js'), content: 'x' }, 'Write'), 0)
})

test('leak: Read of a credential file and Grep printing its lines are blocked', () => {
  const blocks = (name, ti) => hook('leak-sentinel', { tool_name: name, tool_input: ti }).status
  assert.equal(blocks('Read', { file_path: '/repo/.env' }), 2)
  assert.equal(blocks('Read', { file_path: '/home/u/.ssh/id_rsa' }), 2)
  assert.equal(blocks('Grep', { pattern: 'KEY', path: '.env.local', output_mode: 'content' }), 2)
  assert.equal(blocks('Grep', { pattern: 'BEGIN', glob: '*.pem', output_mode: 'content' }), 2)
  assert.equal(blocks('Read', { file_path: '/repo/.env.example' }), 0)
  assert.equal(blocks('Read', { file_path: '/repo/src/env.ts' }), 0)
  assert.equal(blocks('Grep', { pattern: 'KEY', path: '.env' }), 0, 'file names only: nothing printed')
})

test('mode: margin reports an editorial objection without blocking; safety still blocks', () => {
  const { dir } = repo()
  const payload = { cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, 'package.json'), content: '{"name":"t","dependencies":{"left-pad":"1.0.0"}}\n' } }
  assert.equal(hook('dep-sentinel', payload).status, 2, 'redline blocks before the edit lands')

  assert.equal(cli(dir, ['mode', 'margin']).status, 0)
  const margin = hook('dep-sentinel', payload)
  assert.equal(margin.status, 0)
  assert.match(JSON.parse(margin.stdout).systemMessage, /margin, advisory.*left-pad/s)
  assert.equal(hook('leak-sentinel', { cwd: dir, tool_input: { command: 'cat .env' } }).status, 2)

  assert.equal(cli(dir, ['mode', 'off']).status, 0)
  assert.equal(hook('dep-sentinel', payload).stdout, '')
  assert.equal(cli(dir, ['mode', 'loud']).status, 1)
  assert.match(cli(dir, ['mode']).stdout, /omit mode: off/)
})

test('`/omit <mode>` typed by the user sets the mode; other prompts pass untouched', () => {
  const { dir } = repo()
  const r = hook('mode-prompt', { cwd: dir, prompt: '/omit margin' })
  assert.equal(r.status, 0)
  assert.equal(readFileSync(join(dir, '.omit', 'mode'), 'utf8').trim(), 'margin')
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /margin/)
  const other = hook('mode-prompt', { cwd: dir, prompt: 'please set /omit off for me later' })
  assert.deepEqual([other.status, other.stdout], [0, ''])
})

test('session baseline: audit --session charges the session only with its own edits', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'before.txt'), 'dirt from before the session\n')
  assert.equal(hook('session-baseline', { cwd: dir, session_id: 's1', source: 'startup' }).status, 0)
  writeFileSync(join(dir, 'mine.txt'), 'written in the session\n')
  // A resumed session keeps the baseline it started with.
  hook('session-baseline', { cwd: dir, session_id: 's2', source: 'resume' })

  const files = JSON.parse(cli(dir, ['audit', '--session', '--json']).stdout).files.map((f) => f.path)
  assert.deepEqual(files, ['mine.txt'])
  assert.ok(JSON.parse(cli(dir, ['audit', '--json']).stdout).files.some((f) => f.path === 'before.txt'), 'plain audit still counts against HEAD')
  assert.equal(cli(dir, ['audit', '--session', '--base', 'HEAD']).status, 1)
})

test('receipts: the check budget is spent before running, not after', () => {
  const { dir } = repo()
  mkdirSync(join(dir, '.omit'))
  const tried = Array.from({ length: 101 }, (_, i) => ({ rung: 2, absent: `nothing${i}` }))
  writeFileSync(join(dir, '.omit', 'receipts.jsonl'), JSON.stringify({ claim: 'new-dep', rung: 7, dep: 'x', tried }) + '\n')
  const [r] = verifyLedger(dir)
  assert.equal(r.status, 'unverifiable')
  assert.match(r.checks[0].detail, /cap/)
})

test('`omit hook run` runs only omit\'s own hooks', () => {
  const { dir } = repo()
  assert.equal(cli(dir, ['hook', 'run', 'command-sentinel'], JSON.stringify({ cwd: dir, tool_input: { command: 'rm -rf ~' } })).status, 2)
  assert.equal(cli(dir, ['hook', 'run', 'command-sentinel'], JSON.stringify({ cwd: dir, tool_input: { command: 'ls' } })).status, 0)
  assert.equal(cli(dir, ['hook', 'run', '../../etc/passwd'], '{}').status, 1)
})

test('installers: Claude mirrors the plugin, the pre-commit gate is pinned, doctor reads Ribhu', () => {
  const { dir } = repo()
  assert.equal(cli(dir, ['hook', 'install', 'claude']).status, 0)
  const installed = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks
  const plugin = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8')).hooks
  assert.deepEqual(Object.keys(installed).sort(), Object.keys(plugin).sort())

  assert.equal(cli(dir, ['hook', 'install']).status, 0)
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8'), new RegExp(`@sriinnu/omit@${version.replaceAll('.', '\\.')} gate`))
  assert.match(cli(dir, ['hook', 'install']).stdout, /already installed/)

  assert.equal(cli(dir, ['hook', 'install', 'ribhu']).status, 0)
  const ribhu = doctor(dir, join(dir, 'no-codex-home')).findings.filter((f) => f.file?.endsWith(join('.ribhu', 'hooks.json')))
  assert.ok(ribhu.length > 0 && ribhu.every((f) => f.level === 'info'), JSON.stringify(ribhu))
  assert.ok(ribhu.some((f) => /script exists: .*ribhu-adapter\.mjs/.test(f.message)))
})

test('final-draft gate: the first refusal states the exact lines, and a draft copied from it passes', () => {
  // Found live: the agent gets one retry before stop_hook_active waves it through,
  // so a refusal that names the fields loosely let a free-form draft end the session.
  const { dir } = repo()
  writeFileSync(join(dir, 'app.py'), 'x = 2\n')
  const first = hook('final-draft-gate', { hook_event_name: 'Stop', cwd: dir })
  assert.equal(first.status, 2)
  const lines = first.stderr.match(/^(?:files touched: \d+|lines \+\d+ −\d+|new dependencies: \d+)$/gm)
  assert.deepEqual(lines, ['files touched: 1', 'lines +1 −0', 'new dependencies: 0'])
  mkdirSync(join(dir, '.omit'))
  writeFileSync(join(dir, '.omit', 'final-draft.md'), lines.join('\n') + '\n')
  assert.equal(hook('final-draft-gate', { hook_event_name: 'Stop', cwd: dir }).status, 0)
})

// The cases below are the two reviewers' reproductions, kept so they stay closed.
test('review: TLS, git and leak bypasses the first rules missed', () => {
  for (const c of [j('git config http.sslVerify ', '"false"'), j('git -c http.ssl', 'Verify=0 clone x'), j('npm --strict-ssl ', 'false i'), j('wget --no-check-', 'cert x'), j('curl --proxy-', 'insecure x'), j('aws s3 ls --no-', 'verify-ssl')]) {
    assert.ok(findTls(c).length, c)
  }
  for (const c of ['git push origin +main', 'sh -c "git reset --hard"', 'git -c "core.hooksPath=/x" commit', 'git checkout -- *', 'git restore *', 'git checkout -f']) {
    assert.ok(assessCommand(c).length, c)
  }
  assert.deepEqual(assessCommand('git log --grep commit -n 5'), [])
  const leak = (tool_name, tool_input) => hook('leak-sentinel', { tool_name, tool_input }).status
  assert.equal(leak('Grep', { glob: '.env*', output_mode: 'content' }), 2)
  assert.equal(leak('Grep', { path: '/home/u/.aws', output_mode: 'content' }), 2)
  for (const f of ['/home/u/.npmrc', 'a/.docker/config.json', 'server.key', '.envrc']) assert.equal(leak('Read', { file_path: f }), 2, f)
  for (const c of ['sed -n 1p .env', 'git show HEAD:.env', 'base64 .env']) assert.equal(leak('Bash', { command: c }), 2, c)
  assert.equal(leak('Read', { file_path: '/x/src/secrets.ts' }), 0)
  assert.equal(leak('Bash', { command: 'sed -i s/a/b/ .env' }), 0)
  const ribhu = spawnSync(process.execPath, [join(HOOKS, 'ribhu-adapter.mjs'), 'leak-sentinel'], { encoding: 'utf8', env: ENV, input: JSON.stringify({ event: 'PreToolUse', tool: 'grep', input: { path: '.env', output_mode: 'content' } }) })
  assert.equal(ribhu.status, 2)
})

test('review: tamper sees a rewritten hook, a kill switch, and shell writes that do not name the file', () => {
  const { dir } = repo()
  mkdirSync(join(dir, '.claude'))
  const settings = join(dir, '.claude', 'settings.json')
  writeFileSync(settings, JSON.stringify({ permissions: { allow: [] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/command-sentinel.mjs' }] }] } }, null, 2))
  const status = (tool_name, tool_input) => hook('tamper-sentinel', { cwd: dir, tool_name, tool_input }).status
  const edit = (old_string, new_string) => status('Edit', { file_path: settings, old_string, new_string })
  assert.equal(edit('node /x/command-sentinel.mjs', 'true # command-sentinel.mjs'), 2)
  assert.equal(edit('"matcher": "Bash"', '"matcher": "None"'), 2)
  assert.equal(edit('"hooks": {', '"hooksX": {'), 2)
  assert.equal(edit('"permissions"', '"disableAllHooks": true, "permissions"'), 2)
  assert.equal(status('Write', { file_path: join(dir, '.claude', 'settings.local.json'), content: '{"env":{"OMIT_OFF":"1"}}' }), 2)
  assert.equal(edit('"allow": []', '"allow": ["Bash(ls)"]'), 0)
  for (const c of ['cd .claude && echo {} > settings.json', 'cd .omit && echo off > mode', 'rm -rf .claude', 'mv .claude x', 'cat a > .claude/set*.json']) {
    assert.equal(status('Bash', { command: c }), 2, c)
  }
  for (const c of ['grep hooks .claude/settings.json | tee out.txt', 'echo x >> .omit/receipts.jsonl', 'cat .claude/agents/*.md > all.md']) {
    assert.equal(status('Bash', { command: c }), 0, c)
  }
})

test('review: the mode is never written through a symlink', () => {
  const { dir } = repo()
  writeFileSync(join(dir, 'victim.txt'), 'precious')
  mkdirSync(join(dir, '.omit'))
  symlinkSync(join(dir, 'victim.txt'), join(dir, '.omit', 'mode'))
  assert.throws(() => writeMode(dir, 'margin'), /symlink/)
  assert.equal(readFileSync(join(dir, 'victim.txt'), 'utf8'), 'precious')
})

test('review: reinstalling replaces omit entries from another source or version, and refreshes the pin', () => {
  const { dir } = repo()
  mkdirSync(join(dir, '.claude'))
  const old = 'npx -y @sriinnu/omit@0.0.1 hook run final-draft-gate'
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: old }, { type: 'command', command: './mine.sh' }] }] } }))
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpx -y @sriinnu/omit@0.0.1 gate || exit 1\n')
  assert.equal(cli(dir, ['hook', 'install', 'claude']).status, 0)
  assert.equal(cli(dir, ['hook', 'install']).status, 0)
  const stop = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks.Stop[0].hooks.map((h) => h.command)
  assert.equal(stop.length, 2)
  assert.ok(!stop.includes(old) && stop.includes('./mine.sh'))
  assert.ok(!readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8').includes('@0.0.1'))
})

// The day-to-day tester's reproductions: ordinary work that was blocked, and a gate that never ran.
test('usability: redirects to /dev/null, grep patterns, clearing innerHTML and $HOME subpaths pass', () => {
  const { dir } = repo()
  const tamper = (command) => hook('tamper-sentinel', { cwd: dir, tool_name: 'Bash', tool_input: { command } }).status
  for (const c of ['ls .omit 2>/dev/null', 'cat .claude/settings.json 2>&1', 'ls .omit/ >/dev/null']) assert.equal(tamper(c), 0, c)
  assert.equal(tamper('echo {} > .claude/settings.json 2>/dev/null'), 2)
  const leak = (command) => hook('leak-sentinel', { tool_name: 'Bash', tool_input: { command } }).status
  for (const c of ['grep -rn "process\\.env\\." .', 'grep -rn "credentials" src', 'grep -e .env src']) assert.equal(leak(c), 0, c)
  for (const c of ['grep -rn TOKEN .env', 'grep password credentials.json']) assert.equal(leak(c), 2, c)
  assert.deepEqual(findHazards([j('el.inner', 'HTML = ""')]), [])
  assert.ok(findHazards([j('el.inner', 'HTML = x')]).length)
  assert.deepEqual(assessCommand('rm -rf "$HOME/.cache/myapp"'), [])
  assert.ok(assessCommand('rm -rf $HOME/*').length)
})

test('usability: the pre-commit gate runs before an existing hook can exit 0', () => {
  const { dir } = repo()
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit')
  writeFileSync(hookPath, '#!/bin/sh\necho my-lint\nexit 0\n')
  assert.equal(cli(dir, ['hook', 'install']).status, 0)
  assert.match(readFileSync(hookPath, 'utf8'), /^#!\/bin\/sh\nnpx -y @sriinnu\/omit@[\w.-]+ gate \|\| exit 1\necho my-lint/)
  writeFileSync(hookPath, '#!/usr/bin/env python3\nprint(1)\n')
  assert.notEqual(cli(dir, ['hook', 'install']).status, 0)
  assert.equal(readFileSync(hookPath, 'utf8'), '#!/usr/bin/env python3\nprint(1)\n')
})

test('usability: doctor counts duplicates within one hooks file, not across agents', () => {
  const { dir } = repo()
  cli(dir, ['hook', 'install', 'codex'])
  cli(dir, ['hook', 'install', 'claude'])
  assert.ok(!doctor(dir, join(dir, 'no-codex-home')).findings.some((f) => /duplicate/.test(f.message)))
})

test('adversary: continuations, wrappers, subshells and spelled-out roots still delete the root', () => {
  for (const c of [
    'git reset \\\n --hard', 'git push \\\n --force', j('curl \\\n -', 'k https://x'),
    'echo a\nrm -rf /', 'echo a & rm -rf /', '(rm -rf /)', '{ rm -rf /; }', 'if true; then rm -rf /; fi',
    'for d in /; do rm -rf $d; done', 'time rm -rf /', 'echo $(rm -rf /)', 'env rm -rf /', 'nice -n 5 rm -rf ~',
    '\\rm -rf /', '/bin/rm -rf /', 'rm -rf /./', 'rm -rf ~/.', 'rm -rf /bin/..', 'rm -rf /*/',
    'git "push" --force', 'git push origin "+main"', 'git switch -f main', 'git commit --no-veri',
  ]) assert.ok(assessCommand(c).length, c)
  for (const c of ['rm -rf ${OUT:?}/x', 'npm test 2>&1 | tail', 'git commit -m "docs: --no-verify"', 'rm -rf node_modules dist']) assert.deepEqual(assessCommand(c), [], c)
  const long = hook('command-sentinel', { tool_input: { command: 'rm -rf / ; echo "' + 'a\\"'.repeat(30000) } })
  assert.equal(long.status, 2)
  assert.match(long.stderr, /too long/)
})

test('adversary: tamper reads paths as the filesystem does, and guards .git/config and the baseline', () => {
  const { dir } = repo()
  const bash = (command) => hook('tamper-sentinel', { cwd: dir, tool_name: 'Bash', tool_input: { command } }).status
  for (const c of [
    'rm -r .cla*', 'rm -r .c[l]aude', `python3 -c "import os;os.remove('.claude/settings.json')"`, 'python3 - <<E\nopen(".omit/mode","w")\nE',
    'dd if=/dev/null of=.claude/settings.json', 'ex -sc wq .omit/mode', 'echo off > .omit//mode', 'echo off > .omit/./mode',
    'echo off > .OMIT/MODE', 'echo x \\\n > .omit/mode', 'echo "[core]" >> .git/config', 'echo {} > .git/omit/baseline.json',
  ]) assert.equal(bash(c), 2, c)
  for (const c of ['cat .git/config', 'git config user.name x', 'rm -rf .cache*', 'python3 -c "print(1)"']) assert.equal(bash(c), 0, c)
  const write = (file_path) => hook('tamper-sentinel', { cwd: dir, tool_name: 'Write', tool_input: { file_path, content: 'x' } }).status
  for (const p of ['.omit//mode', '.omit/MODE', '.git/config', '.git/omit/baseline.json']) assert.equal(write(p), 2, p)
})

test('adversary: leak, hazard and dependency rules cover the shapes found', () => {
  const leak = (command) => hook('leak-sentinel', { tool_name: 'Bash', tool_input: { command } }).status
  for (const c of ['cat .env >&2', 'cat .e*', 'cat ~/.aws/*', 'cat prod.env', 'cat id_rsa.bak', 'env | sort', 'export -p', 'echo $GITHUB_TOKEN', 'gh auth token', 'cat \\\n .env']) assert.equal(leak(c), 2, c)
  for (const c of ['cat .env.example', 'cat id_rsa.pub', 'set -e', 'echo $PATH', 'env | grep -q FOO']) assert.equal(leak(c), 0, c)
  for (const t of [j('x.rejectUnauthorized', ' = false'), j('ctx.check_hostname', ' = False'), j('CURLOPT_SSL_', 'VERIFYPEER, false'), j('strictSSL', ': false'), j('exec', '("ls " + x)'), j('os.sys', 'tem("ls "+x)'), j('marshal.lo', 'ads(b)')]) {
    assert.ok(findHazards([t]).length, t)
  }
  assert.deepEqual(findHazards(['password: ${DB_PASSWORD}']), [])
  for (const p of ['dev-requirements.txt', 'requirements/base.txt', 'constraints.txt']) assert.ok(isManifest(p), p)
  assert.deepEqual(addedDeps('package.json', '{}', '{"overrides":{"a":"1"},"pnpm":{"overrides":{"b":"1"}}}'), ['a', 'b'])
  assert.deepEqual(addedDeps('requirements.txt', '', '-e git+https://x/y.git'), ['git+https://x/y.git'])
  assert.deepEqual(addedDeps('go.mod', '', 'replace a => evil.example/b v1.0.0'), ['evil.example/b'])
})
