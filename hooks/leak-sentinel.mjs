#!/usr/bin/env node
// PreToolUse hook: blocks shell commands that print an EXISTING secret's raw
// value to stdout before they run — keychain/vault reads, env dumps, cat'ing
// credential files. The agent's own transcript is not a safe place for a real
// API key, so this is enforced, not left to the model remembering to redact.
import { readFileSync } from 'node:fs'
import { assessLeak } from '../lib/leaks.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const command = data.tool_input?.command
if (!command) process.exit(0)

const findings = assessLeak(command)
if (findings.length === 0) process.exit(0)

console.error(
  'omit blocks this command: it would print a real secret into the transcript.\n' +
    findings.map((f) => `  [${f.rule}] ${f.reason}`).join('\n') +
    '\nIf a real secret already leaked, treat it as burned and rotate it. ' +
    'Suppress a reviewed command with: # omit-allow: <reason>',
)
process.exit(2)
