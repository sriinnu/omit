#!/usr/bin/env node
// PreToolUse hook: assesses shell commands BEFORE they execute and blocks the
// classic agent disasters (recursive deletes of home/system paths, deletes
// through unset variables, disk overwrites). The user's machine is load-bearing.
import { readFileSync } from 'node:fs'
import { assessCommand } from '../lib/danger.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

// Claude Code's hook contract: exit 2 blocks the tool call, and every other
// non-zero code is a NON-BLOCKING error — the model sees it and can carry on.
// So the only safe exit for a hook that did not finish its job is 2. A crash at
// exit 1 is this hook silently not running, which is the one outcome it exists
// to prevent; a non-string `command` used to throw out of assessCommand and let
// the command through.
const block = (message) => {
  console.error(message)
  process.exit(2)
}

// The payload comes from the harness, not the agent, so a payload we cannot even
// parse is not evidence about anything the agent did — and harnesses do not agree
// on shape (Codex's apply_patch sends different fields). Skip, do not block the
// session on it.
let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

try {
  const command = data.tool_input?.command
  if (command === undefined || command === null || command === '') process.exit(0) // not a shell tool call
  if (typeof command !== 'string') {
    block(
      'omit blocks this command: its text was not a string, so nothing about it could be assessed.\n' +
        'Send the command as a string, or set OMIT_OFF=1 to run without the sentinel.'
    )
  }

  const findings = assessCommand(command)
  if (findings.length === 0) process.exit(0)

  console.error(
    'omit blocks this command: the machine is load-bearing.\n' +
      findings.map((f) => `  [${f.rule}] ${f.reason}`).join('\n') +
      '\nUse a narrower target inside the workspace, guard variables with ${VAR:?}, ' +
      'or, only after genuine review with the user, append: # omit-allow: <reason>'
  )
  process.exit(2)
} catch (e) {
  block(
    `omit could not assess this command (${e?.message ?? e}).\n` +
      'Blocking the command rather than waving it through: a check that did not run is not a check that passed.'
  )
}
