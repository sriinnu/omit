#!/usr/bin/env node
// PostToolUse hook: raises a blocking objection when a new dependency lands
// in a manifest without a receipt in .omit/receipts.jsonl.
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { isManifest, addedDeps } from '../lib/deps.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const file = data.tool_input?.file_path
if (!file || !isManifest(file)) process.exit(0)

const cwd = data.cwd ?? process.cwd()
let diff = ''
try {
  diff = execSync(`git diff HEAD -- "${file}"`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
} catch {
  process.exit(0) // not a git repo: nothing to compare against
}

const deps = addedDeps(basename(file), diff)
if (deps.length === 0) process.exit(0)

let receipts = ''
const ledger = join(cwd, '.omit', 'receipts.jsonl')
if (existsSync(ledger)) receipts = readFileSync(ledger, 'utf8')

const uncited = deps.filter((d) => !receipts.includes(d))
if (uncited.length === 0) process.exit(0)

console.error(
  `omit objects: new dependenc${uncited.length > 1 ? 'ies' : 'y'} with no receipt: ${uncited.join(', ')}.\n` +
    `Omissions 2-5 come first: show the codebase, stdlib, platform, and installed deps cannot cover this.\n` +
    `If they truly cannot, append the citation to .omit/receipts.jsonl ` +
    `({"claim":"new dep ${uncited[0]} required","receipt":"<what you verified>","rung":7}) and re-apply. Otherwise revert the manifest change.`
)
process.exit(2)
