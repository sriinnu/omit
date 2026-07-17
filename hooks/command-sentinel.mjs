#!/usr/bin/env node
// PreToolUse hook: assesses shell commands BEFORE they execute and blocks the
// classic agent disasters (recursive deletes of home/system paths, deletes
// through unset variables, disk overwrites). The user's machine is load-bearing.
import { readFileSync } from 'node:fs'
import { assessCommand } from '../lib/danger.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const command = data.tool_input?.command
if (!command) process.exit(0)

const findings = assessCommand(command)
if (findings.length === 0) process.exit(0)

console.error(
  'omit blocks this command: the machine is load-bearing.\n' +
    findings.map((f) => `  [${f.rule}] ${f.reason}`).join('\n') +
    '\nUse a narrower target inside the workspace, guard variables with ${VAR:?}, ' +
    'or, only after genuine review with the user, append: # omit-allow: <reason>'
)
process.exit(2)
