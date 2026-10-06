// omit codemode: one MCP tool that runs a model-written script in a sandbox
// whose only capability is the read-only tools below.
//
// An agent exploring a repo pays for every intermediate result: each file read
// and each grep is a round-trip whose raw output lands in the transcript and is
// re-sent on every later turn. Here the reads happen inside the script and only
// what it returns reaches the model.
//
// The sandbox itself is not written here. Isolation is load-bearing, and
// node:vm is not isolation (the receipt in .omit/receipts.jsonl executes the
// escape), so it comes from @earendil-works/pi-codemode: a QuickJS VM compiled
// to wasm with no file system, network or process. It is an optional peer and
// only this command loads it, so the rest of the CLI stays zero-dependency.
//
// omitted: write and edit tools: a nested write is not seen by the host's
// hooks, so it has to carry the hazard, dependency and lint gates itself; add
// them once bench/ shows the read side pays for the surface.
// omitted: a tree walk for directories that are not git repositories: `files`
// and `grep` read the tree through git, which is what knows what is ignored;
// add one if a host turns out to run this outside repositories.
import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { findHazards } from './hazards.mjs'

const run = promisify(execFile)

const TIMEOUT_MS = 60_000
// What may reach the transcript from one script. Past it the middle is cut: a
// script that returns this much has not filtered anything.
const MAX_OUTPUT_CHARS = 20_000
// A read is one JSON round trip into the VM, so a multi-gigabyte log would be
// held three times over before the script saw a byte.
const MAX_READ_BYTES = 8 << 20
const GIT_BUFFER = 64 << 20

// load-bearing: path confinement. The lexical check refuses `..` and absolute
// paths before the file system is touched; the realpath check refuses a
// symlink inside the workspace that points out of it.
async function confine(root, path) {
  if (typeof path !== 'string' || !path) throw new Error('path must be a non-empty string')
  const outside = (full) => full !== root && !full.startsWith(root + sep)
  if (outside(resolve(root, path))) throw new Error(`${path} is outside the workspace`)
  let full
  try {
    full = await realpath(resolve(root, path))
  } catch (e) {
    throw new Error(`${path}: ${e.code === 'ENOENT' ? 'no such file or directory' : e.message}`)
  }
  if (outside(full)) throw new Error(`${path} is outside the workspace`)
  return full
}

// Async on purpose: the host owns the script's deadline, and a synchronous git
// call would hold the event loop that enforces it. It also lets a script's
// Promise.all actually run its calls side by side.
async function git(root, args) {
  try {
    return (await run('git', args, { cwd: root, encoding: 'utf8', maxBuffer: GIT_BUFFER })).stdout
  } catch (e) {
    if (e.code === 1 && !e.stderr) return '' // `git grep` found nothing
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('too much output to hold: narrow the pattern or pass `under`')
    throw new Error(String(e.stderr ?? '').trim() || e.message)
  }
}

const pathspec = async (root, under) => (under === undefined ? [] : ['--', relative(root, await confine(root, under)) || '.'])

export const toolsFor = (root) => [
  {
    name: 'files',
    description: 'List files, tracked and untracked, minus what git ignores.',
    inputSchema: { type: 'object', properties: { under: { type: 'string', description: 'only files below this directory' } } },
    outputSchema: { type: 'array', items: { type: 'string' } },
    execute: async ({ under } = {}) => {
      const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...(await pathspec(root, under))])
      return [...new Set(out.split('\0').filter(Boolean))]
    },
  },
  {
    name: 'read',
    description: 'Read one file as text.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    outputSchema: { type: 'string' },
    execute: async ({ path } = {}) => {
      const full = await confine(root, path)
      const { size } = await stat(full)
      if (size > MAX_READ_BYTES) throw new Error(`${path} is ${size} bytes, past the ${MAX_READ_BYTES} a read holds: use grep`)
      return readFile(full, 'utf8')
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with an extended regular expression.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, under: { type: 'string', description: 'only files below this directory' } },
      required: ['pattern'],
    },
    outputSchema: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'number' }, text: { type: 'string' } }, required: ['path', 'line', 'text'] },
    },
    execute: async ({ pattern, under } = {}) => {
      if (typeof pattern !== 'string' || !pattern) throw new Error('pattern must be a non-empty string')
      // -z: a path is then followed by NUL, never by the `:` a file name may contain.
      const out = await git(root, ['grep', '-nIz', '-E', '--untracked', '-e', pattern, ...(await pathspec(root, under))])
      return out.split('\n').filter(Boolean).map((row) => {
        const [path, line, ...text] = row.split('\0')
        return { path, line: Number(line), text: text.join('\0') }
      })
    },
  },
]

// What a finished script hands back to the model.
export function shape(text, isError) {
  // load-bearing: secrets stay out of the transcript. A script that read a
  // credentials file must not be able to return it, and the same rules that
  // stop a key landing in a file decide what counts as one.
  const secrets = findHazards(text.split('\n')).filter((h) => h.type === 'secret')
  if (secrets.length) {
    const where = secrets.map((h) => `${h.rule} (output line ${h.line})`).join(', ')
    return { isError: true, text: `omit: output withheld, it carries ${where}. A transcript is not a safe place for a key: filter it out in the script and return only what you need.` }
  }
  if (!text) return { isError, text: '(no output: return a value or call text())' }
  if (text.length <= MAX_OUTPUT_CHARS) return { isError, text }
  const half = MAX_OUTPUT_CHARS / 2
  return {
    isError,
    text: `${text.slice(0, half)}\n[omit: ${text.length - MAX_OUTPUT_CHARS} characters cut here. Return less: count, aggregate or filter in the script.]\n${text.slice(-half)}`,
  }
}

export async function execute(code, { CodemodeSandbox, root }) {
  const sandbox = new CodemodeSandbox({ tools: toolsFor(root), timeoutMs: TIMEOUT_MS })
  try {
    const r = await sandbox.execute(code)
    const parts = r.output.map((item) => (item.type === 'text' ? item.text : `[${item.type} output is not supported]`))
    if (r.ok && r.value !== undefined) parts.push(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 1))
    if (!r.ok) parts.push(`Script error (${r.error.kind}): ${r.error.stack ?? r.error.message}`)
    return shape(parts.join('\n'), !r.ok)
  } finally {
    await sandbox.close()
  }
}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

// MCP over stdio is one JSON-RPC message per line, and three methods are all a
// tools-only server answers, so the protocol is spoken here rather than
// imported. stdout carries nothing but those messages.
export function serve({ sandbox, root, version, stdin = process.stdin, stdout = process.stdout }) {
  const tool = {
    name: 'codemode',
    description:
      'Run JavaScript that explores this repository through read-only tools, and get back only what the script returns. ' +
      'Use it instead of many separate reads and searches: call tools in parallel with Promise.all, filter and count in the script, return the conclusion. ' +
      `\`code\` is the body of an async function: \`await\` and \`return\` work at the top level, text(value) adds to the output, and there is no fs, network or process. Paths are relative to ${root}.\n\n` +
      sandbox.renderDeclarations({ tools: toolsFor(root) }),
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript source, the body of an async function' } }, required: ['code'] },
    annotations: { readOnlyHint: true },
  }
  const invalid = (message) => Object.assign(new Error(message), { code: -32602 })
  // A Map, not an object literal: `method` is untrusted, and "constructor"
  // would otherwise resolve to something callable.
  const methods = new Map([
    ['initialize', (p) => ({ protocolVersion: PROTOCOLS.includes(p?.protocolVersion) ? p.protocolVersion : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'omit', version } })],
    ['ping', () => ({})],
    ['tools/list', () => ({ tools: [tool] })],
    ['tools/call', async (p) => {
      if (p?.name !== tool.name) throw invalid(`unknown tool: ${p?.name}`)
      if (typeof p.arguments?.code !== 'string') throw invalid('`code` must be a string')
      const { text, isError } = await execute(p.arguments.code, { CodemodeSandbox: sandbox.CodemodeSandbox, root })
      return { content: [{ type: 'text', text }], isError }
    }],
  ])
  const send = (message) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  createInterface({ input: stdin }).on('line', async (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: -32700, message: 'parse error' } })
    }
    if (message?.id === undefined) return // a notification: nothing to answer
    const method = methods.get(message.method)
    if (!method) return send({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
    try {
      send({ id: message.id, result: await method(message.params) })
    } catch (e) {
      send({ id: message.id, error: { code: Number.isInteger(e.code) ? e.code : -32603, message: e.message } })
    }
  })
}
