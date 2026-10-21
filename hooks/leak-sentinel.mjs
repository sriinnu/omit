#!/usr/bin/env node
// PreToolUse hook: blocks shell commands, and Read/Grep calls, that print an
// EXISTING secret's raw value into the transcript before they run: keychain
// and vault reads, env dumps, cat'ing credential files. The agent's own transcript is not a safe place for a real
// API key, so this is enforced, not left to the model remembering to redact.
import { readFileSync } from 'node:fs'
import { MAX_COMMAND, TOO_LONG } from '../lib/hazards.mjs'
import { assessLeak, isCredentialFile } from '../lib/leaks.mjs'

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
  // Read, and Grep showing matched lines, print a file into the transcript the
  // way `cat` and `grep` do, so a credential file is the same objection.
  const ti = data.tool_input ?? {}
  const shown = data.tool_name === 'Read' ? [ti.file_path] : data.tool_name === 'Grep' && ti.output_mode === 'content' ? [ti.path, ti.glob] : []
  // A glob star stands for some name or none: `*.pem` is judged as `x.pem`, `.env*` as `.env`.
  const target = shown.find((p) => typeof p === 'string' && (isCredentialFile(p.replaceAll('*', 'x')) || isCredentialFile(p.replaceAll('*', ''))))
  if (target !== undefined) {
    block(
      `omit blocks this ${data.tool_name}: ${target} looks like a credential file, and its contents would land in the transcript.\n` +
        'Check for a key without printing it (grep -q, wc -c), or read the .example file. ' +
        'If a real secret already leaked, treat it as burned and rotate it.'
    )
  }

  const command = ti.command
  if (command === undefined || command === null || command === '') process.exit(0)
  if (typeof command !== 'string') {
    block(
      'omit blocks this command: its text was not a string, so it could not be checked for a secret.\n' +
        'Send the command as a string, or set OMIT_OFF=1 to run without the sentinel.'
    )
  }

  if (command.length > MAX_COMMAND) block(TOO_LONG)
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
