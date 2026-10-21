#!/usr/bin/env node
// UserPromptSubmit hook: `/omit <mode>` typed by the user is the one way the
// mode changes from inside a session. The prompt is the user's, so writing
// `.omit/mode` here is the user's act; the tamper sentinel keeps the agent from
// doing the same with a tool call. Anything else passes untouched.
import { readFileSync } from 'node:fs'
import { DESCRIBE, writeMode } from '../lib/mode.mjs'

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

// `/omit:omit` is the same command, namespaced by the plugin.
const m = /^\s*\/omit(?::omit)?\s+(margin|redline|rewrite|off)\s*$/i.exec(typeof data.prompt === 'string' ? data.prompt : '')
if (!m) process.exit(0)

const mode = m[1].toLowerCase()
try {
  writeMode(data.cwd ?? process.cwd(), mode)
} catch (e) {
  // load-bearing: a mode the user asked for and did not get must not read as set.
  console.error(`omit: could not write .omit/mode (${e?.message ?? e}); the mode is unchanged.`)
  process.exit(2)
}
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `omit mode is now ${mode}, set by the user. ${DESCRIBE[mode]}` } }))
