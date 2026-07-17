#!/usr/bin/env node
// Stop hook: the turn may not end with an edited working tree and no Final Draft.
// The deletion pass is a gate, not a suggestion.
import { readFileSync, statSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

if (process.env.OMIT_OFF === '1') process.exit(0)

let data = {}
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {}
if (data.stop_hook_active) process.exit(0) // never loop the gate

const cwd = data.cwd ?? process.cwd()
let changed = []
try {
  changed = execSync('git status --porcelain', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.*-> /, ''))
    .filter((p) => !p.startsWith('.omit/'))
} catch {
  process.exit(0)
}
// omitted: distinguishing this session's edits from pre-existing dirt: git has no
// session concept; set OMIT_OFF=1 in dirty-tree workflows until a marker file lands.
if (changed.length === 0) process.exit(0)

const draft = join(cwd, '.omit', 'final-draft.md')
if (existsSync(draft)) {
  const draftTime = statSync(draft).mtimeMs
  const newestEdit = Math.max(
    ...changed.map((p) => {
      try {
        return statSync(join(cwd, p)).mtimeMs
      } catch {
        return 0 // deleted file: cannot be newer than the draft
      }
    })
  )
  if (draftTime >= newestEdit) process.exit(0)
}

console.error(
  'omit: the working tree changed but there is no current Final Draft.\n' +
    'Working code is a first draft. Edit your own diff once (dead branches, unused params/imports, ' +
    'speculative options, restating comments, single-caller indirection), then write the net report to ' +
    '.omit/final-draft.md: files touched, lines +/-, new dependencies, footnotes recorded. Then finish.'
)
process.exit(2)
