#!/usr/bin/env node
// Stop hook: the turn may not end with an edited working tree and no Final Draft.
// The deletion pass is a gate, not a suggestion.
//
// The draft has to be a REPORT, not a file. Existence and mtime alone let a
// 0-byte .omit/final-draft.md satisfy a gate whose promise is that a session
// cannot end with an edited tree and no net report, so the counts the skill asks
// for — files touched, lines added/removed, new dependencies — are read out of
// the draft and cross-checked against the tree.
import { readFileSync, lstatSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { probe, git, fileAtRevision } from '../lib/git.mjs'
import { isManifest, addedDeps } from '../lib/deps.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

// Exit 2 blocks the stop (the model gets another turn); anything else non-zero is
// a non-blocking error and the session ends on an unchecked report.
const block = (message) => {
  console.error(message)
  process.exit(2)
}

let data = {}
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {}
if (data.stop_hook_active) process.exit(0) // never loop the gate

const DRAFT_MAX = 1 << 20

// repoRoot() answers null for "not a repository" and for "git could not answer",
// which want opposite exits — see dep-sentinel for the full note.
function repoRootOrNull(cwd) {
  const r = probe(cwd, ['rev-parse', '--show-toplevel'])
  if (r.ok) return r.out.trim()
  if (/not a git repository|must be run in a work tree/i.test(String(r.reason))) return null
  throw new Error(`git could not report the repository root (${r.reason})`)
}

// Text, or null when there is nothing to count (binary, unreadable, gone).
function readText(path) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

// omit counts a file's lines the way an editor does: a trailing newline ends the
// last line rather than starting an empty one.
const lineCount = (text) => {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

// Everything `omit audit` counts, per file: tracked changes (staged or not —
// `git diff HEAD` sees both) plus untracked files, which `git diff` cannot see
// and which are most of a working tree mid-session. Binary and unreadable files
// carry no line counts and are left out, which is the same choice audit makes —
// that is what lets a draft pasting audit's verdict match unchanged.
function changeSet(root) {
  const rows = []
  let binaries = 0
  for (const line of git(root, ['diff', 'HEAD', '--numstat']).split('\n').filter(Boolean)) {
    const [a, d, rel] = line.split('\t')
    if (a === '-') {
      binaries++
      continue
    }
    rows.push({ rel, added: +a, deleted: +d, untracked: false })
  }
  for (const rel of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    // omit's own bookkeeping is not the change, and audit skips it the same way —
    // that is what lets a draft pasting audit's verdict match this count.
    // omitted: the same for a tracked .omit/ change, which audit does count; the
    // caller excludes it from `changed` and keeps this set for that comparison.
    if (rel.startsWith('.omit/')) continue
    const text = readText(join(root, rel))
    if (text === null) continue
    rows.push({ rel, added: lineCount(text), deleted: 0, untracked: true })
  }
  return { rows, binaries }
}

// The counts the report is checked against. `files` is the size of the set, so
// every call here passes the set it wants counted.
function counts(root, rows) {
  let added = 0
  let deleted = 0
  let deps = 0
  for (const r of rows) {
    added += r.added
    deleted += r.deleted
    if (!isManifest(r.rel)) continue
    const after = readText(join(root, r.rel)) ?? '' // deleted or unreadable: declares nothing
    const before = fileAtRevision(root, 'HEAD', r.rel)
    // `{failed:true}` is not an empty manifest: reading it as one would turn
    // every dependency it declares into a "new" one.
    if (before.failed) throw new Error(`git could not read ${r.rel} at HEAD (${before.reason}) — the new-dependency count would be a guess`)
    deps += addedDeps(basename(r.rel), before.present ? before.text : '', after).length
  }
  return { files: rows.length, added, deleted, deps }
}

// The draft is untrusted input like the ledger: a symlink to /dev/zero (or any
// pipe) would hang the Stop hook forever. lstat, not stat, so nothing is
// followed, and the size is capped rather than read into memory.
function readDraft(path) {
  const st = lstatSync(path)
  if (!st.isFile()) throw new Error(`${path} is not a regular file`)
  if (st.size > DRAFT_MAX) throw new Error(`${path} is ${st.size} bytes, over the ${DRAFT_MAX}-byte cap`)
  return { text: readFileSync(path, 'utf8'), mtimeMs: st.mtimeMs }
}

// Form is read leniently — audit's own verdict line parses, and so does prose like
// "files touched: 2" — content strictly: all three counts must be stated, because
// a report that cannot be checked is not a net report.
const firstInt = (text, patterns) => {
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return +m[1]
  }
  return null
}

const firstPair = (text, patterns) => {
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return [+m[1], +m[2]]
  }
  return null
}

function parseReport(text) {
  const files = firstInt(text, [
    /across\s+(\d+)\s+files?\b/i, // audit's line: "net: +3 −0 lines across 1 file"
    /\bfiles?\s+(?:touched|changed|edited)\s*[:=]\s*\**(\d+)/i,
    /\bfiles?\s*[:=]\s*\**(\d+)/i,
    /(\d+)\s+files?\b/i,
  ])
  const lines = firstPair(text, [
    /net\s*[:=]?\s*\+\s*(\d+)\s*[−–-]\s*(\d+)/i, // audit's line
    /\+\s*(\d+)\s*[−–/-]\s*(\d+)/, // "+12 −3", "+12/-3"
    /\blines?\b[^\n]{0,32}?(\d+)\s*[−–/-]\s*(\d+)/i,
  ])
  const none = /\bno\s+new\s+(?:deps?|dependencies)\b|\bnew\s+(?:deps?|dependencies)\s*[:=]\s*\**\s*(?:none|zero|nil|n\/a)\b/i
  const deps = none.test(text)
    ? 0
    : firstInt(text, [/\bnew\s+(?:deps?|dependencies)\s*[:=]\s*\**(\d+)/i, /\bnew\s+dependenc\w*\s*[:=]\s*\**(\d+)/i, /\bdependenc\w*\s+(?:added|introduced)\s*[:=]?\s*(\d+)/i])
  return { files, lines, deps }
}

function main() {
  const cwd = data.cwd ?? process.cwd()
  const root = repoRootOrNull(cwd)
  if (root === null) process.exit(0) // not a repository: there is no diff to gate

  const { rows, binaries } = changeSet(root)
  const changed = rows.filter((r) => !r.rel.startsWith('.omit/'))
  // omitted: distinguishing this session's edits from pre-existing dirt: git has no
  // session concept; set OMIT_OFF=1 in dirty-tree workflows until a marker file lands.
  if (changed.length === 0) process.exit(0)

  const draftPath = join(root, '.omit', 'final-draft.md')
  let draft
  try {
    draft = readDraft(draftPath)
  } catch (e) {
    block(
      `omit: the working tree changed but there is no readable .omit/final-draft.md${e.code === 'ENOENT' ? '' : ` (${e.message})`}.\n` +
        'Working code is a first draft. Edit your own diff once (dead branches, unused params/imports, ' +
        'speculative options, restating comments, single-caller indirection), then write the net report to ' +
        '.omit/final-draft.md: files touched, lines +/-, new dependencies, footnotes recorded. Then finish.'
    )
  }

  // A draft older than the newest edit describes a tree that no longer exists.
  const newestEdit = Math.max(...changed.map((r) => statSync(join(root, r.rel), { throwIfNoEntry: false })?.mtimeMs ?? 0))
  if (draft.mtimeMs < newestEdit) {
    block(
      'omit: the Final Draft is older than the newest edit — it reports a tree that no longer exists.\n' +
        'Re-run `omit audit`, update the counts in .omit/final-draft.md, then finish.'
    )
  }

  const actual = counts(root, changed)
  const report = parseReport(draft.text)
  const missing = []
  if (report.files === null) missing.push('"files touched: <n>"')
  if (report.lines === null) missing.push('"lines +<added> −<removed>"')
  if (report.deps === null) missing.push('"new dependencies: <n>"')
  if (missing.length) {
    block(
      `omit: .omit/final-draft.md does not state ${missing.join(', ')}.\n` +
        `The gate is on the report, not on the file existing. This tree right now: ${actual.files} file(s), ` +
        `+${actual.added} −${actual.deleted} lines, ${actual.deps} new dependenc${actual.deps === 1 ? 'y' : 'ies'}.\n` +
        'Those are the numbers `omit audit` prints. Write them down, say what you cut, then finish.'
    )
  }

  const wrong = []
  if (report.files !== actual.files) wrong.push(`  files touched: draft says ${report.files}, the tree has ${actual.files}`)
  if (report.lines[0] !== actual.added || report.lines[1] !== actual.deleted) {
    wrong.push(`  lines: draft says +${report.lines[0]} −${report.lines[1]}, the tree has +${actual.added} −${actual.deleted}`)
  }
  if (report.deps !== actual.deps) wrong.push(`  new dependencies: draft says ${report.deps}, the tree has ${actual.deps}`)
  if (wrong.length === 0) {
    if (binaries > 0) console.error(`omit: note — ${binaries} changed file(s) are binary; no line counts describe them.`)
    process.exit(0)
  }

  // One honest mismatch passes with a note. `omit audit` counts omit's own ledger
  // files when they are tracked, and this gate counts the change itself: a draft
  // that pasted audit's verdict is reporting the tree accurately, and the only
  // thing it includes that the gate excludes is omit's bookkeeping. Nothing a
  // developer did is hidden by letting that through — which is not true of any
  // other mismatch, where the draft is simply stating a number the tree
  // contradicts.
  const audited = counts(root, rows)
  if (report.files === audited.files && report.lines[0] === audited.added && report.lines[1] === audited.deleted && report.deps === audited.deps) {
    console.error(
      "omit: note — the Final Draft matches `omit audit`'s counts, which include omit's own tracked files under .omit/.\n" +
        'The gate counts the change itself; the difference is omit\'s bookkeeping, not your work.'
    )
    process.exit(0)
  }

  block(
    `omit: the Final Draft reports numbers the tree contradicts:\n${wrong.join('\n')}\n` +
      `This tree right now: ${actual.files} file(s), +${actual.added} −${actual.deleted} lines, ${actual.deps} new dependenc${actual.deps === 1 ? 'y' : 'ies'}.\n` +
      'Fix the numbers in .omit/final-draft.md (untracked files count — `git diff --stat` cannot see them), then finish.'
  )
}

try {
  main()
} catch (e) {
  block(
    `omit could not complete the Final Draft check (${e?.message ?? e}).\n` +
      'Blocking the stop rather than ending the session on a report nothing was compared against. ' +
      'Fix the error, or set OMIT_OFF=1 if this is not a working session to gate.'
  )
}
