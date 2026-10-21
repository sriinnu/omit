#!/usr/bin/env node
// Stop hook: the turn may not end with an edited working tree and no Final Draft.
// The deletion pass is a gate, not a suggestion. On SubagentStop the same gate
// holds a subagent that edited files to its own Final Draft before it reports
// back; a read-only subagent passes.
//
// The change is this session's when the SessionStart baseline belongs to it:
// the baseline tree against a snapshot of the tree now, so dirt that was there
// before the session started is not charged to it. Without one it is HEAD
// against the working tree, as `omit audit` counts.
//
// The draft has to be a REPORT, not a file. Existence and mtime alone let a
// 0-byte .omit/final-draft.md satisfy a gate whose promise is that a session
// cannot end with an edited tree and no net report, so the counts the skill asks
// for — files touched, lines added/removed, new dependencies — are read out of
// the draft and cross-checked against the tree.
import { readFileSync, lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { git, fileAtRevision, parseNumstat, readBaseline, repoRootStrict, snapshotTree } from '../lib/git.mjs'
import { isManifest, addedDeps } from '../lib/deps.mjs'
import { object } from '../lib/mode.mjs'

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
const TRANSCRIPT_MAX = 64 << 20

// Whether a subagent's transcript records a file edit. Unreadable or absent
// reads as no: the main session's Stop gate still counts the tree, so a
// read-only subagent is never held to a report on the parent's edits.
function subagentEdited(path) {
  if (typeof path !== 'string') return false
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > TRANSCRIPT_MAX) return false
    return readFileSync(path, 'utf8')
      .split('\n')
      .some((l) => l.includes('"tool_use"') && /"name"\s*:\s*"(?:Edit|Write|MultiEdit|NotebookEdit)"/.test(l))
  } catch {
    return false
  }
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
function changeSet(root, base) {
  const rows = []
  let binaries = 0
  // A baseline snapshot already holds the untracked files, and omit's own
  // directory is left out by pathspec, the way `omit audit --session` does.
  const range = base ? [base, snapshotTree(root), '--', '.', ':(exclude).omit'] : ['HEAD']
  for (const row of parseNumstat(git(root, ['diff', '--numstat', '-z', '-M', ...range]))) {
    if (row.added === '-') {
      binaries++
      continue
    }
    rows.push({ rel: row.path, oldRel: row.oldPath, added: +row.added, deleted: +row.deleted })
  }
  if (base) return { rows, binaries }
  for (const rel of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    // omit's own bookkeeping is not the change, and audit skips it the same way —
    // that is what lets a draft pasting audit's verdict match this count.
    // omitted: the same for a tracked .omit/ change, which audit does count; the
    // caller excludes it from `changed` and keeps this set for that comparison.
    if (rel.startsWith('.omit/')) continue
    const text = readText(join(root, rel))
    if (text === null) continue
    rows.push({ rel, oldRel: rel, added: lineCount(text), deleted: 0 })
  }
  return { rows, binaries }
}

// The counts the report is checked against. `files` is the size of the set, so
// every call here passes the set it wants counted.
function counts(root, rows, base) {
  let added = 0
  let deleted = 0
  let deps = 0
  for (const r of rows) {
    added += r.added
    deleted += r.deleted
    if (!isManifest(r.rel)) continue
    const after = readText(join(root, r.rel)) ?? '' // deleted or unreadable: declares nothing
    const before = fileAtRevision(root, base ?? 'HEAD', r.oldRel)
    // `{failed:true}` is not an empty manifest: reading it as one would turn
    // every dependency it declares into a "new" one.
    if (before.failed) throw new Error(`git could not read ${r.oldRel} at ${base ?? 'HEAD'} (${before.reason}) — the new-dependency count would be a guess`)
    deps += addedDeps(r.rel, before.present ? before.text : '', after).length
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
  // Editorial: the mode decides whether this blocks or advises.
  const refuse = (message) => object(cwd, message, data.hook_event_name)
  if (data.hook_event_name === 'SubagentStop' && !subagentEdited(data.agent_transcript_path)) process.exit(0)
  const root = repoRootStrict(cwd)
  if (root === null) process.exit(0) // not a repository: there is no diff to gate

  // Only this session's own baseline: another session's would hide this one's
  // earlier edits, so anything else falls back to HEAD, which hides nothing.
  const baseline = readBaseline(root)
  const base = baseline && typeof data.session_id === 'string' && baseline.session === data.session_id ? baseline.tree : null
  const auditCmd = base ? '`omit audit --session`' : '`omit audit`'
  const { rows, binaries } = changeSet(root, base)
  const changed = rows.filter((r) => !r.rel.startsWith('.omit/'))
  if (changed.length === 0) process.exit(0)

  const actual = counts(root, changed, base)
  // The agent gets one retry (stop_hook_active ends the gate after it), so the
  // first refusal spells out the exact lines the parser reads.
  const shape =
    `files touched: ${actual.files}\nlines +${actual.added} −${actual.deleted}\n` +
    `new dependencies: ${actual.deps}\n(those are this tree's counts now; update them if you edit further)`
  const draftPath = join(root, '.omit', 'final-draft.md')
  let draft
  try {
    draft = readDraft(draftPath)
  } catch (e) {
    refuse(
      `omit: the working tree changed but there is no readable .omit/final-draft.md${e.code === 'ENOENT' ? '' : ` (${e.message})`}.\n` +
        'Working code is a first draft. Edit your own diff once (dead branches, unused params/imports, ' +
        'speculative options, restating comments, single-caller indirection), then write the net report to ' +
        `.omit/final-draft.md, with these three lines exactly as shown, plus what you cut and any footnotes:\n${shape}\nThen finish.`
    )
  }

  // A draft older than the newest edit describes a tree that no longer exists.
  const newestEdit = Math.max(...changed.map((r) => statSync(join(root, r.rel), { throwIfNoEntry: false })?.mtimeMs ?? 0))
  if (draft.mtimeMs < newestEdit) {
    refuse(
      'omit: the Final Draft is older than the newest edit — it reports a tree that no longer exists.\n' +
        `Update the counts in .omit/final-draft.md to:\n${shape}\nThen finish.`
    )
  }

  const report = parseReport(draft.text)
  const missing = []
  if (report.files === null) missing.push('"files touched: <n>"')
  if (report.lines === null) missing.push('"lines +<added> −<removed>"')
  if (report.deps === null) missing.push('"new dependencies: <n>"')
  if (missing.length) {
    refuse(
      `omit: .omit/final-draft.md does not state ${missing.join(', ')}.\n` +
        `The gate is on the report, not on the file existing. This tree right now: ${actual.files} file(s), ` +
        `+${actual.added} −${actual.deleted} lines, ${actual.deps} new dependenc${actual.deps === 1 ? 'y' : 'ies'}.\n` +
        `Those are the numbers ${auditCmd} prints. Write them down, say what you cut, then finish.`
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
  const audited = counts(root, rows, base)
  if (report.files === audited.files && report.lines[0] === audited.added && report.lines[1] === audited.deleted && report.deps === audited.deps) {
    console.error(
      "omit: note — the Final Draft matches `omit audit`'s counts, which include omit's own tracked files under .omit/.\n" +
        'The gate counts the change itself; the difference is omit\'s bookkeeping, not your work.'
    )
    process.exit(0)
  }

  refuse(
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
