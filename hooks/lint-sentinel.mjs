#!/usr/bin/env node
// PostToolUse hook: runs the repo's OWN linter on the file just edited and
// objects immediately on errors. omit brings no lint rules of its own.
import { readFileSync } from 'node:fs'
import { lintFiles } from '../lib/lint.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const file = data.tool_input?.file_path
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
