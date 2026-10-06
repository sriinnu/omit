// codemode has two contracts and both are tested as contracts. The tools decide
// what a script may reach, so they are driven against a real repository on disk.
// The server's only interface is JSON-RPC lines on stdio, so it is driven that
// way, first with a stand-in sandbox (runs everywhere) and then as the real
// process with the real sandbox (runs where the optional peer is installed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { serve, shape, toolsFor } from '../lib/codemode.mjs'

const BIN = fileURLToPath(new URL('../bin/omit.mjs', import.meta.url))
// No global config: a developer's git config must not leak into the fixture.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
// Assembled, so this file does not itself carry something shaped like a key.
const FAKE_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

function repo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'omit-codemode-')))
  const dir = join(base, 'repo')
  mkdirSync(join(dir, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir, env: ENV })
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1\n// needle: one\n')
  writeFileSync(join(dir, 'ignored.txt'), 'needle: ignored\n')
  writeFileSync(join(base, 'outside.txt'), 'needle: outside\n')
  symlinkSync(join(base, 'outside.txt'), join(dir, 'link.txt'))
  execFileSync('git', ['add', '.gitignore', 'src/a.js'], { cwd: dir, env: ENV })
  writeFileSync(join(dir, 'src', 'untracked: odd name.js'), '// needle: two\n')
  return dir
}

const tool = (dir, name) => toolsFor(dir).find((t) => t.name === name).execute

test('files lists tracked and untracked files and leaves out what git ignores', async () => {
  const dir = repo()
  assert.deepEqual((await tool(dir, 'files')()).sort(), ['.gitignore', 'link.txt', 'src/a.js', 'src/untracked: odd name.js'])
  assert.deepEqual((await tool(dir, 'files')({ under: 'src' })).sort(), ['src/a.js', 'src/untracked: odd name.js'])
})

test('grep finds untracked matches, skips ignored files, and survives a colon in a file name', async () => {
  const dir = repo()
  const hits = (await tool(dir, 'grep')({ pattern: 'needle: (one|two)' })).sort((x, y) => x.path.localeCompare(y.path))
  assert.deepEqual(hits, [
    { path: 'src/a.js', line: 2, text: '// needle: one' },
    { path: 'src/untracked: odd name.js', line: 1, text: '// needle: two' },
  ])
  // No match is an answer, not a failure: git exits 1 for it.
  assert.deepEqual(await tool(dir, 'grep')({ pattern: 'zz_never_here_zz' }), [])
  // A broken pattern is a failure, and must not read as "no matches".
  await assert.rejects(tool(dir, 'grep')({ pattern: '(' }), /parenthes|Unmatched|regex/i)
})

test('read stays inside the workspace: no `..`, no absolute path, no symlink out', async () => {
  const dir = repo()
  const read = tool(dir, 'read')
  assert.equal(await read({ path: 'src/a.js' }), 'export const a = 1\n// needle: one\n')
  await assert.rejects(read({ path: '../outside.txt' }), /outside the workspace/)
  await assert.rejects(read({ path: join(dir, '..', 'outside.txt') }), /outside the workspace/)
  // The link's own path is inside; what it points at is not.
  await assert.rejects(read({ path: 'link.txt' }), /outside the workspace/)
  await assert.rejects(read({ path: 'nope.js' }), /no such file/)
  await assert.rejects(tool(dir, 'files')({ under: '..' }), /outside the workspace/)
})

test('a result carrying a secret is withheld whole, whatever the script meant', () => {
  const r = shape(`line one\nkey = ${FAKE_KEY}\n`, false)
  assert.equal(r.isError, true)
  assert.match(r.text, /output withheld.*aws-access-key \(output line 2\)/)
  assert.ok(!r.text.includes(FAKE_KEY))
})

test('a long result keeps its head and tail and says how much was cut', () => {
  const r = shape(`HEAD${'x'.repeat(50_000)}TAIL`, false)
  assert.equal(r.isError, false)
  assert.ok(r.text.startsWith('HEAD') && r.text.endsWith('TAIL'))
  assert.match(r.text, /\[omit: 30008 characters cut here/)
  assert.equal(shape('', false).text, '(no output: return a value or call text())')
})

// The skill is what teaches an agent the script API, so it is pinned to the
// tools: add or rename one and this fails before an agent is taught a call that
// does not exist.
test('the codemode skill documents exactly the tools a script can call', () => {
  const skill = readFileSync(new URL('../skills/omit-codemode/SKILL.md', import.meta.url), 'utf8')
  const documented = [...skill.matchAll(/^\| `tools\.(\w+)\(/gm)].map((m) => m[1])
  assert.deepEqual(documented, toolsFor('/work').map((t) => t.name))
})

// One JSON-RPC exchange against serve(), with a sandbox that records what it
// was given instead of running it.
function session(dir) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const seen = []
  const sandbox = {
    renderDeclarations: ({ tools }) => `declare const tools: { ${tools.map((t) => t.name).join('; ')} }`,
    CodemodeSandbox: class {
      async execute(code) {
        seen.push(code)
        return { ok: true, output: [{ type: 'text', text: 'printed' }], value: { ran: code } }
      }
      async close() {}
    },
  }
  serve({ sandbox, root: dir, version: '9.9.9', stdin, stdout })
  const lines = []
  let wake = () => {}
  let buffered = ''
  stdout.on('data', (d) => {
    buffered += d
    for (let i; (i = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(i + 1)) lines.push(JSON.parse(buffered.slice(0, i)))
    wake()
  })
  const next = async () => {
    while (!lines.length) await new Promise((r) => (wake = r))
    return lines.shift()
  }
  return { write: (line) => stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`), next, seen }
}

test('the server answers the MCP handshake, lists one read-only tool, and runs it', async () => {
  const s = session('/work')
  s.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  assert.deepEqual(await s.next(), { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'omit', version: '9.9.9' } } })
  // A version this server does not know gets one it does, not an echo.
  s.write({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal((await s.next()).result.protocolVersion, '2025-06-18')

  // A notification is not answered: the next reply on the wire belongs to id 3.
  s.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
  s.write({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const listed = await s.next()
  assert.equal(listed.id, 3)
  const [tool, ...rest] = listed.result.tools
  assert.equal(rest.length, 0)
  assert.equal(tool.name, 'codemode')
  assert.deepEqual(tool.annotations, { readOnlyHint: true })
  assert.deepEqual(tool.inputSchema.required, ['code'])
  assert.match(tool.description, /relative to \/work/)
  assert.match(tool.description, /declare const tools: \{ files; read; grep \}/)

  s.write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'codemode', arguments: { code: 'return 1' } } })
  assert.deepEqual(await s.next(), { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'printed\n{\n "ran": "return 1"\n}' }], isError: false } })
  assert.deepEqual(s.seen, ['return 1'])
})

test('the server refuses what it does not understand, by JSON-RPC code, and keeps serving', async () => {
  const s = session('/work')
  s.write('{not json')
  assert.deepEqual((await s.next()).error, { code: -32700, message: 'parse error' })
  s.write({ jsonrpc: '2.0', id: 1, method: 'resources/list' })
  assert.equal((await s.next()).error.code, -32601)
  // `method` is untrusted: a name that exists on every object is still unknown.
  s.write({ jsonrpc: '2.0', id: 2, method: 'constructor' })
  assert.equal((await s.next()).error.code, -32601)
  s.write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'other', arguments: { code: 'x' } } })
  assert.deepEqual((await s.next()).error, { code: -32602, message: 'unknown tool: other' })
  s.write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'codemode', arguments: { code: 7 } } })
  assert.equal((await s.next()).error.code, -32602)
  assert.deepEqual(s.seen, [])
  s.write({ jsonrpc: '2.0', id: 5, method: 'ping' })
  assert.deepEqual(await s.next(), { jsonrpc: '2.0', id: 5, result: {} })
})

// The real process. Which half runs depends on whether the optional peer is
// installed, and each half asserts something: where the sandbox is missing the
// command has to say so and exit, not start a server that cannot run a script.
const installed = await import('@earendil-works/pi-codemode').then(
  () => true,
  (e) => {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e
    // CI's codemode job installs the peer and says so here, so a resolution
    // problem there fails the run instead of quietly skipping the one case
    // the job exists for.
    if (process.env.OMIT_CODEMODE_REQUIRED === '1') throw e
    return false
  }
)

test('omit codemode without its sandbox says how to get it and exits 1', { skip: installed && 'the sandbox is installed here' }, async () => {
  const child = spawn(process.execPath, [BIN, 'codemode'], { cwd: repo(), env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const code = await new Promise((r) => child.on('close', r))
  assert.equal(code, 1)
  assert.match(stderr, /npm install @earendil-works\/pi-codemode/)
})

// `run` is the same feature without a server: what an agent with a shell uses.
// stdout is the answer and the exit status says whether there is one.
test('omit codemode run: one script in on stdin, one answer out, exit 1 when there is none', { skip: !installed && 'the optional peer @earendil-works/pi-codemode is not installed, so the sandbox was NOT exercised' }, async () => {
  const dir = repo()
  const run = (args, input) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'codemode', ...args], { cwd: dir, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(input ?? '')
    })
  assert.deepEqual(await run(['run'], `return (await tools.files({ under: 'src' })).length`), { code: 0, stdout: '2\n', stderr: '' })
  // The script lives outside the workspace: inside, it would match its own pattern.
  const file = join(dir, '..', 'q.js')
  writeFileSync(file, `return (await tools.grep({ pattern: 'needle' })).map((h) => h.line)`)
  assert.deepEqual(JSON.parse((await run(['run', file])).stdout), [2, 1])
  const refused = await run(['run'], `return await tools.read({ path: '../outside.txt' })`)
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /outside the workspace/)
  const unknown = await run(['serve'])
  assert.deepEqual([unknown.code, unknown.stderr], [1, 'omit: usage: omit codemode [run [file]]\n'])
})

test('omit codemode end to end: a real script, in the real sandbox, over stdio', { skip: !installed && 'the optional peer @earendil-works/pi-codemode is not installed, so the sandbox was NOT exercised' }, async () => {
  const dir = repo()
  writeFileSync(join(dir, 'creds.txt'), `aws_access_key_id = ${FAKE_KEY}\n`)
  const child = spawn(process.execPath, [BIN, 'codemode'], { cwd: dir, env: ENV, stdio: ['pipe', 'pipe', 'inherit'] })
  const replies = new Map()
  let buffered = ''
  child.stdout.on('data', (d) => {
    buffered += d
    for (let i; (i = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(i + 1)) {
      const m = JSON.parse(buffered.slice(0, i))
      replies.get(m.id)(m)
    }
  })
  let id = 0
  const call = (method, params) =>
    new Promise((resolve) => {
      replies.set(++id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const script = async (code) => (await call('tools/call', { name: 'codemode', arguments: { code } })).result
  try {
    assert.equal((await call('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'omit')
    assert.match((await call('tools/list')).result.tools[0].description, /read\(args: \{ path: string; \}\): Promise<string>/)

    // The point of the thing: the reads happen in there, the answer comes out.
    const explored = await script(`
      const names = (await tools.files({ under: 'src' })).sort()
      const sources = await Promise.all(names.map((path) => tools.read({ path })))
      const hits = await tools.grep({ pattern: 'needle' })
      return { names, chars: sources.map((s) => s.length), hits: hits.length, host: [typeof process, typeof require, typeof fetch] }`)
    assert.equal(explored.isError, false)
    assert.deepEqual(JSON.parse(explored.content[0].text), {
      names: ['src/a.js', 'src/untracked: odd name.js'],
      chars: [34, 15],
      hits: 2,
      host: ['undefined', 'undefined', 'undefined'],
    })

    const escaped = await script(`return await tools.read({ path: '../outside.txt' })`)
    assert.equal(escaped.isError, true)
    assert.match(escaped.content[0].text, /outside the workspace/)

    // Reading the file is allowed; carrying the key out is not.
    const counted = await script(`return (await tools.read({ path: 'creds.txt' })).length`)
    assert.deepEqual([counted.isError, counted.content[0].text], [false, '41'])
    const leaked = await script(`return await tools.read({ path: 'creds.txt' })`)
    assert.equal(leaked.isError, true)
    assert.ok(!leaked.content[0].text.includes(FAKE_KEY))

    const thrown = await script(`text('partial'); throw new Error('boom')`)
    assert.equal(thrown.isError, true)
    assert.match(thrown.content[0].text, /^partial\nScript error \(script\): Error: boom/)
  } finally {
    child.stdin.end()
  }
  assert.equal(await new Promise((r) => child.on('close', r)), 0)
})
