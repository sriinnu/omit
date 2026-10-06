#!/usr/bin/env node
// Opt-in context controls. Structured tool results are never replaced.
import { readFileSync } from 'node:fs'
import { digest, readWarnings, preview, existingSessionDir, archiveText, repeatCount } from '../lib/context.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)
try {
  const data = JSON.parse(readFileSync(0, 'utf8'))
  if (!['Bash', 'exec_command', 'shell'].includes(data.tool_name)) process.exit(0)
  const command = data.tool_input?.command ?? data.tool_input?.cmd
  if (data.hook_event_name === 'PreToolUse') {
    const warnings = readWarnings(command)
    if (warnings.length) console.log(JSON.stringify({ systemMessage: `omit: ${warnings.join(' ')}` }))
    process.exit(0)
  }
  if (data.hook_event_name !== 'PostToolUse' || typeof data.tool_response !== 'string') process.exit(0)
  const text = data.tool_response
  const limit = Number(process.env.OMIT_OUTPUT_CHARS ?? 6000)
  if (!Number.isInteger(limit) || limit < 1000 || limit > 100000) throw new Error('OMIT_OUTPUT_CHARS must be 1000..100000')
  if (typeof data.session_id !== 'string' || !data.session_id) throw new Error('missing session_id')
  const dir = existingSessionDir(data.cwd ?? process.cwd(), data.session_id)
  const count = typeof command === 'string' ? repeatCount(dir, digest(`${command}\0${text}`)) : 0
  const warning = count === 3 ? 'omit: three consecutive identical commands returned identical text. Check whether another run adds information.' : ''
  const shortened = preview(text, limit)
  if (!shortened) {
    if (warning) console.log(JSON.stringify({ systemMessage: warning }))
    process.exit(0)
  }
  const path = archiveText(dir, text)
  console.log(JSON.stringify({
    decision: 'block',
    reason: `${shortened.head}\n[omit: ${shortened.omitted} characters outside head/tail; full output: ${path}]\n${shortened.diagnostics ? `[selected diagnostics]\n${shortened.diagnostics}\n` : ''}${shortened.tail}`,
    ...(warning ? { systemMessage: warning } : {}),
  }))
} catch {
  // Preserve the original result if archiving or decoding fails.
  console.log(JSON.stringify({ systemMessage: 'omit: context guard could not complete; original output was not replaced.' }))
}
