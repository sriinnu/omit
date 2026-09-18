#!/usr/bin/env node
// PreToolUse hook: blocks shell commands that print an EXISTING secret's raw
// value to stdout before they run — keychain/vault reads, env dumps, cat'ing
// credential files. The agent's own transcript is not a safe place for a real
// API key, so this is enforced, not left to the model remembering to redact.
import { readFileSync } from 'node:fs'
import { assessLeak } from '../lib/leaks.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

// Exit 2 blocks the tool call; any other non-zero code is a non-blocking error
// the model can retry straight through. So a hook that did not finish has to
// exit 2 — a crash at exit 1 is this check silently not happening, and the
// secret prints. A non-string `command` used to do exactly that: assessLeak
// threw, node exited 1, the command ran.
const block = (message) => {
  console.error(message)
  process.exit(2)
}

// Harness-authored payload: unreadable means "not a call I can judge", not
// evidence the agent did something.
let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

try {
  const command = data.tool_input?.command
  if (command === undefined || command === null || command === '') process.exit(0)
  if (typeof command !== 'string') {
    block(
      'omit blocks this command: its text was not a string, so it could not be checked for a secret.\n' +
        'Send the command as a string, or set OMIT_OFF=1 to run without the sentinel.'
    )
  }

  const findings = assessLeak(command)
  if (findings.length === 0) process.exit(0)

  console.error(
    'omit blocks this command: it would print a real secret into the transcript.\n' +
      findings.map((f) => `  [${f.rule}] ${f.reason}`).join('\n') +
      '\nIf a real secret already leaked, treat it as burned and rotate it. ' +
      'Suppress a reviewed command with: # omit-allow: <reason>'
  )
  process.exit(2)
} catch (e) {
  block(
    `omit could not assess this command for a leak (${e?.message ?? e}).\n` +
      'Blocking the command rather than waving it through: a check that did not run is not a check that passed.'
  )
}
