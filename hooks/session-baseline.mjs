#!/usr/bin/env node
// SessionStart hook. Two jobs:
//
// 1. Record what the tree looked like when this session began (a git tree
//    object, tracked and untracked alike), so the Final Draft gate charges the
//    session with its own edits and not with dirt that was already there. Only
//    a new session writes one: a resumed or compacted session keeps the
//    baseline it started with, and the gate ignores one that is not its own.
// 2. Tell the model which mode omit is in, when it is not the default, so the
//    instruction survives a compaction.
//
// SessionStart cannot block, and a missing baseline only means the gate counts
// against HEAD, which hides nothing. So a failure here is reported, not fatal.
import { readFileSync } from 'node:fs'
import { repoRootStrict, writeBaseline } from '../lib/git.mjs'
import { DESCRIBE, readMode } from '../lib/mode.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
const cwd = data.cwd ?? process.cwd()

try {
  const root = repoRootStrict(cwd)
  if (root !== null && typeof data.session_id === 'string' && ['startup', 'clear', 'fork', undefined].includes(data.source)) {
    writeBaseline(root, data.session_id)
  }
} catch (e) {
  console.error(`omit: no session baseline recorded (${e?.message ?? e}); the Final Draft gate will count against HEAD.`)
}

const mode = readMode(cwd)
if (mode !== 'redline') {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `omit mode: ${mode}. ${DESCRIBE[mode]}` } }))
}
