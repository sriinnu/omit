#!/usr/bin/env node
// Blocks hardcoded secrets, TLS-verification bypasses and injection-prone
// patterns in an edit. Load-bearing lines are never cut - and hazards are never
// shipped. PreToolUse on an edit tool reads the text the tool is about to write,
// so the hazard never lands; PostToolUse reads the file after the fact.
//
// Fires on file edits (Edit|Write|MultiEdit|NotebookEdit) and on Bash, because
// a file also lands through `cat > f`, `tee f` and `sed -i` — and because
// `NotebookEdit` carries no file_path at all, so a notebook cell used to reach
// no sentinel.
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { git, fileAtRevision, repoRelPath, repoRootStrict } from '../lib/git.mjs'
import { findHazards } from '../lib/hazards.mjs'
import { patchPaths } from '../lib/patch-paths.mjs'
import { proposedLines } from '../lib/proposed.mjs'
import { object } from '../lib/mode.mjs'
import { TLS_FIX } from '../lib/tls.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

// Exit 2 blocks the tool call; any other non-zero code is a non-blocking error
// the model sees and moves past. A hook that crashed has not objected.
const block = (message) => {
  console.error(message)
  process.exit(2)
}

// Omit's own directory at the repo root is exempt from the editorial rules: its
// ledger holds `run` snippets, and it is not the change under review. Not from
// the secret rules: a key written to .omit/ is still a key in the repo.
const inOmitDir = (p) => /^\.omit[\\/]/.test(p)
const scan = (lines, rel) => (inOmitDir(rel) ? findHazards(lines).filter((f) => f.type === 'secret') : findHazards(lines))

// A file we cannot read as text has no added lines to scan: a deleted file
// (ENOENT) or a directory (EISDIR) is not content. Anything else is a real
// failure and belongs in the wrapper's exit 2.
function readLines(abs) {
  try {
    return readFileSync(abs, 'utf8').split('\n')
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return []
    throw e
  }
}

// Scan only what this edit added: the diff for a file git already knew, the whole
// file otherwise — a new file has no earlier revision to diff against.
// omitted: skipping a checkout's pre-existing hazards on an untracked file: there
// is no revision to attribute them to, and objecting is the safe side.
function addedLines(abs, rel, root) {
  if (root === null || rel === null) return readLines(abs) // outside git: scan the file as written
  const head = fileAtRevision(root, 'HEAD', rel)
  // `{failed:true}` is not "no earlier revision": treating it as one silently
  // rescans the whole file (a file's worth of pre-existing lines reported as this
  // edit's), and treating it as an empty file would scan nothing at all.
  if (head.failed) throw new Error(`git could not read ${rel} at HEAD (${head.reason}) — the added lines could not be isolated`)
  if (!head.present) return readLines(abs)
  return git(root, ['diff', 'HEAD', '--', rel])
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
}

// The shapes of a shell command that writes file content. This runs on EVERY Bash
// call, so it gates all the work below: no path extraction, no git, until the
// command itself says it wrote something.
const WRITE_SHAPES = /(?:>>?\s*[^\s;&|<>()]|\btee\s+(?:-a\s+)?[^\s;&|<>()]|\bsed\s+[^;|]*\s-i\b|\bdd\s+of=|\bnpm\s+pkg\s+set\b|\btruncate\b)/

const unquote = (s) => s.replace(/^['"]|['"]$/g, '')

// The paths a command plausibly wrote, from a short list of shapes rather than a
// shell parser (a parser is a second implementation of the shell, and a wrong one
// is worse than a missing one).
// omitted: extraction for `python -c "...open('f','w')"`, `awk > ` and friends:
// their command text is scanned for secrets below, which is where a literal in
// such a command would have to appear anyway.
function writtenPaths(command) {
  const out = []
  for (const m of command.matchAll(/>>?\s*("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g)) out.push(unquote(m[1]))
  for (const m of command.matchAll(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g)) out.push(unquote(m[1]))
  for (const m of command.matchAll(/\bsed\s+[^;|]*?\s-i\b[^;|]*/g)) {
    const words = m[0].split(/\s+/).filter((w) => w && !w.startsWith('-'))
    if (words.length > 2) out.push(unquote(words[words.length - 1])) // last non-flag token: the file sed edits
  }
  return out.filter((p) => p && !p.startsWith('/dev/')) // the void is not a file to scan
}

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0) // harness-authored payload we cannot read: not evidence about a file
}

try {
  const ti = data.tool_input ?? {}
  for (const f of ['file_path', 'notebook_path', 'command']) {
    if (ti[f] !== undefined && typeof ti[f] !== 'string') {
      block(
        `omit blocks this edit: the hook was handed a \`${f}\` that is not a path or a command, so nothing behind it could be scanned.\n` +
          'Send the tool input as a string, or set OMIT_OFF=1 to run without the sentinel.'
      )
    }
  }
  const cwd = data.cwd ?? process.cwd()

  const file = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : null
  let findings = []
  const files = patchPaths(data) ?? (file === null ? [] : [file])
  if (files.length) {
    const root = repoRootStrict(cwd)
    for (const file of files) {
      if (/\.lock$/.test(basename(file)) || basename(file) === 'package-lock.json') continue
      const abs = resolve(cwd, file)
      const rel = root === null ? null : repoRelPath(root, abs)
      // Before the edit lands, the tool's own input is the added content (none,
      // for a shape it cannot read: the file on disk is not this edit); after, a
      // notebook's is the cell the tool just wrote.
      const added = data.hook_event_name === 'PreToolUse'
        ? proposedLines(ti, readLines(abs).join('\n')) ?? []
        : typeof ti.new_source === 'string' ? ti.new_source.split('\n') : addedLines(abs, rel, root)
      findings.push(...scan(added, rel ?? file))
    }
  } else if (data.tool_name !== 'apply_patch' && typeof ti.command === 'string' && WRITE_SHAPES.test(ti.command)) {
    const root = repoRootStrict(cwd)
    // The command's own text carries what a heredoc writes. Secret rules only:
    // the injection rules are about code landing in a file, and the file check
    // below covers the files we can locate — running them over every command's
    // text flags read-only commands like a grep of the source for the eval token.
    findings = findHazards(ti.command.split('\n')).filter((f) => f.type === 'secret')
    for (const raw of writtenPaths(ti.command)) {
      const abs = resolve(cwd, raw)
      const rel = root === null ? null : repoRelPath(root, abs)
      if (rel === null) continue // outside the repo
      findings.push(...scan(addedLines(abs, rel, root), rel))
    }
    findings = [...new Map(findings.map((f) => [`${f.type}:${f.rule}:${f.text}`, f])).values()]
  }
  if (findings.length === 0) process.exit(0)

  const secrets = findings.filter((f) => f.type === 'secret')
  const tls = findings.filter((f) => f.type === 'tls')
  const injections = findings.filter((f) => f.type === 'injection')

  let msg = 'omit objects: hazards in this edit:\n'
  for (const f of secrets) msg += `  SECRET  [${f.rule}] ${f.text}\n`
  for (const f of tls) msg += `  TLS     [${f.rule}] ${f.text}\n`
  for (const f of injections) msg += `  INJECT  [${f.rule}] ${f.text}\n`
  msg += secrets.length
    ? 'Secrets never ship: move them to environment variables or a secrets manager and rotate any real key that was just written.\n'
    : ''
  msg += tls.length ? `${TLS_FIX}\nA reviewed line can carry \`omit-allow: <reason>\`.\n` : ''
  msg += injections.length
    ? 'Injection-prone patterns need parameterized queries, safe APIs, or an explicit reviewed `omit-allow: <reason>` on the line.\n'
    : ''
  // Secrets and switched-off certificate checks are safety, and block in every
  // mode; injection patterns alone are editorial, and the mode decides.
  if (secrets.length || tls.length) block(msg.trimEnd())
  object(cwd, msg.trimEnd(), data.hook_event_name)
} catch (e) {
  block(
    `omit could not complete the hazard scan (${e?.message ?? e}).\n` +
      'Blocking the edit rather than accepting a change nothing scanned: a check that did not run is not a check that passed.'
  )
}
