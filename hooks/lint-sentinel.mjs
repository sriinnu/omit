#!/usr/bin/env node
// PostToolUse hook: runs the repo's OWN linter on the file just edited and
// objects immediately on errors. omit brings no lint rules of its own.
import { readFileSync } from 'node:fs'
import { lintFiles } from '../lib/lint.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

// Exit 2 blocks the tool call; any other non-zero code is a non-blocking error
// the model can ignore. A hook that could not run the linter has not reported
// anything, so it must not exit 0 — and it must not exit 1 either.
const block = (message) => {
  console.error(message)
  process.exit(2)
}

// Harness-authored payload: unreadable means "not an edit I can judge".
let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

try {
  const ti = data.tool_input ?? {}
  if (ti.file_path !== undefined && typeof ti.file_path !== 'string') {
    block(
      'omit blocks this edit: the hook was handed a `file_path` that is not a path, so no file could be linted.\n' +
        'Send the tool input as a string, or set OMIT_OFF=1 to run without the sentinel.'
    )
  }
  const file = ti.file_path
  if (!file) process.exit(0)

  const cwd = data.cwd ?? process.cwd()
  const failing = lintFiles(cwd, [file]).filter((r) => !r.ok)
  if (failing.length === 0) process.exit(0)

  console.error(
    `omit: the linter this repo already configured objects (omission 2: use what exists).\n` +
      failing.map((r) => `[${r.linter}]\n${r.output}`).join('\n') +
      `\nFix these now; do not restate or suppress them.`
  )
  process.exit(2)
} catch (e) {
  block(
    `omit could not run the repo's linter (${e?.message ?? e}).\n` +
      'Blocking the edit rather than letting an unchecked file through: a check that did not run is not a check that passed.'
  )
}
