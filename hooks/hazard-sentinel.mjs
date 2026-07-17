#!/usr/bin/env node
// PostToolUse hook: blocks hardcoded secrets and injection-prone patterns
// the moment they land in an edited file. Load-bearing lines are never cut -
// and hazards are never shipped.
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { findHazards } from '../lib/hazards.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const file = data.tool_input?.file_path
if (!file) process.exit(0)
const name = basename(file)
if (name.endsWith('.lock') || name === 'package-lock.json' || file.includes(`${'.omit'}/`)) process.exit(0)

const cwd = data.cwd ?? process.cwd()

// Scan only what this edit added: the diff for tracked files, the whole file if untracked.
let addedLines = []
try {
  const diff = execSync(`git diff HEAD -- "${file}"`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (diff) {
    addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
  }
} catch {}
if (addedLines.length === 0 && existsSync(join(cwd, file).length > 0 ? file : file)) {
  try {
    addedLines = readFileSync(file, 'utf8').split('\n')
  } catch {
    process.exit(0)
  }
}

const findings = findHazards(addedLines)
if (findings.length === 0) process.exit(0)

const secrets = findings.filter((f) => f.type === 'secret')
const injections = findings.filter((f) => f.type === 'injection')

let msg = 'omit objects: hazards in this edit:\n'
for (const f of secrets) msg += `  SECRET  [${f.rule}] ${f.text}\n`
for (const f of injections) msg += `  INJECT  [${f.rule}] ${f.text}\n`
msg += secrets.length
  ? 'Secrets never ship: move them to environment variables or a secrets manager and rotate any real key that was just written.\n'
  : ''
msg += injections.length
  ? 'Injection-prone patterns need parameterized queries, safe APIs, or an explicit reviewed `omit-allow: <reason>` on the line.\n'
  : ''
console.error(msg.trimEnd())
process.exit(2)
