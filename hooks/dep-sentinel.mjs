#!/usr/bin/env node
// PostToolUse hook: raises a blocking objection when a new dependency lands in
// a manifest without a receipt in .omit/receipts.jsonl.
//
// Fires on file edits (Edit|Write|MultiEdit|NotebookEdit) and on Bash: a
// manifest is also rewritten by `npm pkg set`, a redirect, `tee` or `sed -i`,
// and the same change through a different tool is the same change.
import { readFileSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { isManifest, addedDeps, MANIFESTS } from '../lib/deps.mjs'
import { probe, fileAtRevision, repoRelPath } from '../lib/git.mjs'
import { execDisabled, flagOn } from '../lib/exec.mjs'
import { newDepCitations } from '../lib/receipts.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

// Exit 2 blocks the tool call; any other non-zero code is a non-blocking error
// the model can shrug off. This hook's whole value is the objection, so nothing
// here is allowed to end in an uncaught throw.
const block = (message) => {
  console.error(message)
  process.exit(2)
}

// The ledger is executable in the Makefile sense, and `.omit/receipts.jsonl` is
// a file the agent under check can Write. Confirmed: a Write of the manifest plus
// a Write of the ledger ran the receipt's `run` argv as the developer from this
// PostToolUse hook — no Bash call, no permission prompt, exit 0. So the hook
// declines to execute ledger snippets by default and the operator opts in per
// project. OMIT_NO_EXEC is not set here but in the environment of this process,
// which is the same flag lib/receipts.mjs `execDisabled()` reads; the off-values
// are kept identical on purpose ( '', '0', 'false' mean "the flag is off" ), so
// OMIT_HOOK_EXEC=0 really does mean no execution.
const mayExec = flagOn(process.env.OMIT_HOOK_EXEC)
if (!mayExec) process.env.OMIT_NO_EXEC = '1'

// repoRoot() answers null both for "not a repository" and for "git could not
// answer", and those want opposite exits: no repository means there is no HEAD
// to compare against, while a git that cannot run at all (missing binary, dubious
// ownership, unreadable object store) means the check never happened. git's own
// message is the only thing that separates the two, so match on it and fail
// closed on everything else.
function repoRootOrNull(cwd) {
  const r = probe(cwd, ['rev-parse', '--show-toplevel'])
  if (r.ok) return r.out.trim()
  if (/not a git repository|must be run in a work tree/i.test(String(r.reason))) return null
  throw new Error(`git could not report the repository root (${r.reason})`)
}

// The manifests a shell command plausibly rewrote, decided by pure string work:
// this runs on every Bash call, so nothing may spawn a process until a manifest
// is actually in play. Two signals — a package manager whose subcommand writes a
// manifest, and a watched manifest filename anywhere in the command (which is
// what `cat > package.json`, `tee`, `sed -i` and `cp` look like).
const MANAGER_WRITES = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|rm|uninstall|upgrade|update|pkg|link)\b/, 'package.json'],
  [/\b(?:poetry|uv|pipenv)\s+(?:add|remove|install)\b/, 'pyproject.toml'],
  [/\bcargo\s+(?:add|remove|install)\b/, 'Cargo.toml'],
  [/\bgo\s+(?:get|mod\s+(?:tidy|edit))\b/, 'go.mod'],
  [/\b(?:bundle|bundler)\s+(?:add|install|update)\b/, 'Gemfile'],
  [/\bcomposer\s+(?:require|remove|update|install)\b/, 'composer.json'],
]

function manifestsTouched(command) {
  const out = new Set()
  for (const [re, name] of MANAGER_WRITES) if (re.test(command)) out.add(name)
  for (const name of MANIFESTS) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = command.match(new RegExp(`(?:^|[\\s'"=<>|(])([\\w./\\\\-]*${escaped})`, 'i'))
    if (m) out.add(m[1])
  }
  return [...out]
}

// repoRelPath is lexical, and the path the harness sends and the root git
// reports do not always agree on symlinks: on macOS `/tmp` and `/var` are links
// into `/private`, and git answers with the resolved root. A mismatch reads as
// "outside the repo" — which exits 0, a manifest edit silently unaudited. So
// resolve the file and ask again before giving up on it.
function relInRoot(root, abs) {
  const lexical = repoRelPath(root, abs)
  if (lexical !== null) return lexical
  try {
    return repoRelPath(root, realpathSync(abs))
  } catch {
    return null // no such file: nothing to compare, nothing added
  }
}

// A manifest we cannot read as text declares nothing, so nothing was added to it.
// Deleting or replacing it with a directory is not a dependency landing.
function readManifest(abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null
    throw e
  }
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
        `omit blocks this edit: the hook was handed a \`${f}\` that is not a path or a command, so no manifest behind it could be checked.\n` +
          'Send the tool input as a string, or set OMIT_OFF=1 to run without the sentinel.'
      )
    }
  }

  const cwd = data.cwd ?? process.cwd()
  const targets =
    typeof ti.file_path === 'string' ? (isManifest(ti.file_path) ? [ti.file_path] : []) : typeof ti.command === 'string' ? manifestsTouched(ti.command) : []
  if (targets.length === 0) process.exit(0) // an edit that cannot be a manifest edit

  const root = repoRootOrNull(cwd)
  if (root === null) process.exit(0) // not a repository: no history to compare against

  const citations = newDepCitations(root)
  const uncited = new Map()
  for (const target of targets) {
    const abs = resolve(cwd, target)
    const rel = relInRoot(root, abs)
    if (rel === null) continue // outside the repo: not ours to audit
    const after = readManifest(abs)
    if (after === null) continue
    const before = fileAtRevision(root, 'HEAD', rel)
    // `{failed:true}` is not an empty file. Rendering it as one would turn every
    // dependency in the manifest into a "new" one, or hide the added one
    // entirely: either way the hook would be reporting on a comparison it never
    // made. Throw, and let the wrapper object.
    if (before.failed) throw new Error(`git could not read ${rel} at HEAD (${before.reason})`)

    // Compare declared dependency SETS across the two revisions rather than
    // parsing the diff: a brand-new manifest has no earlier revision, so
    // everything in it is new, and a minified manifest declares the same set as
    // a pretty-printed one.
    for (const dep of addedDeps(basename(rel), before.present ? before.text : '', after)) {
      const status = citations.get(dep)?.status
      // Only a VERIFIED new-dep receipt cites a dependency — a ledger line that
      // merely names it is an assertion, which is what this hook exists to stop
      // accepting.
      if (status !== 'verified' && !uncited.has(dep)) uncited.set(dep, status ?? null)
    }
  }
  if (uncited.size === 0) process.exit(0)

  const deps = [...uncited]
  const why = deps
    .map(([dep, status]) =>
      status === 'failed'
        ? `  ${dep}: its receipt was refuted by its own check`
        : status === 'unverifiable'
          ? `  ${dep}: its receipt could not be verified`
          : `  ${dep}: no receipt names it`
    )
    .join('\n')

  const decl = deps.length > 1 ? 'ies' : 'y'
  console.error(
    `omit objects: new dependenc${decl} without a verified receipt: ${deps.map(([d]) => d).join(', ')}.\n` +
      why +
      '\n' +
      // Honest when it declines to execute: a receipt whose only evidence is a
      // `run` snippet was not checked, and saying it is unverified is true where
      // "verified" or silence would not be. It names which switch did the
      // declining, so the reader is not told to set a flag they already set.
      (execDisabled()
        ? 'Ledger snippets were NOT executed here: ' +
          (mayExec
            ? 'OMIT_NO_EXEC is set in this environment.\n'
            : 'a hook does not run `run` argv by default, because a Write of .omit/receipts.jsonl would\n' +
              'otherwise execute as you, with no approval prompt. Set OMIT_HOOK_EXEC=1 to let this hook run one.\n') +
          'A receipt whose evidence is a `run` snippet is unverified here, not refuted — check it with `omit verify`.\n'
        : '') +
      `Omissions 2-5 come first: show the codebase, stdlib, platform, and installed deps cannot cover this.\n` +
      `If they truly cannot, append one line to .omit/receipts.jsonl — the entries under "tried" are re-checked, and must NOT hold:\n` +
      // The printed line has to be a receipt that verifies. `absent` names a
      // symbol the checker searches the whole tracked tree for, so replace it
      // with the one you actually looked for; the claim survives only if that
      // search comes back empty.
      `  {"claim":"new-dep","rung":7,"dep":"${deps[0][0]}","tried":[{"rung":2,"absent":"<symbol you searched for>"}]}\n` +
      `\`omit verify\` checks it before you commit. Otherwise revert the manifest change.`
  )
  process.exit(2)
} catch (e) {
  block(
    `omit could not complete the new-dependency check (${e?.message ?? e}).\n` +
      'Blocking the edit rather than accepting a manifest change nothing audited: a check that did not run is not a check that passed.'
  )
}
