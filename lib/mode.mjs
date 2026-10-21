// How hard omit enforces, read by every editorial hook:
//
//   redline  the default: editorial objections block
//   rewrite  redline, and the agent is told to challenge the assignment too
//   margin   editorial objections are reported, not enforced
//   off      editorial hooks stay quiet
//
// Editorial means the Final Draft, receipts, lint and injection patterns. The
// safety gates (destructive commands, secret leaks and literals, TLS bypass,
// hook tampering) never ask: they block in every mode, and only OMIT_OFF=1 —
// set by a person, in the harness's environment — silences them.
//
// The mode is OMIT_MODE, else `.omit/mode` at the repo root, which the user's
// `/omit <mode>` writes and the tamper sentinel keeps the agent from writing.
// Anything unrecognised reads as redline: a typo must not switch enforcement off.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './git.mjs'

export const MODES = ['margin', 'redline', 'rewrite', 'off']

export const DESCRIBE = {
  redline: 'Full enforcement: editorial objections block.',
  rewrite: 'Full enforcement, and before writing code, challenge the assignment itself: say whether the feature is needed at all (Omission 1) before building it.',
  margin: 'Advisory: Final Draft, receipt, lint and injection objections are reported, not enforced. Safety gates still block.',
  off: 'Editorial gates are off. Safety gates (destructive commands, secrets, TLS bypass, hook tampering) still block.',
}

const modeFile = (dir) => join(repoRoot(dir) ?? dir, '.omit', 'mode')

export function readMode(dir) {
  if (process.env.OMIT_OFF === '1') return 'off'
  let raw = process.env.OMIT_MODE
  if (!raw) {
    try {
      const file = modeFile(dir)
      if (lstatSync(file).isFile()) raw = readFileSync(file, 'utf8').slice(0, 64)
    } catch {}
  }
  const mode = String(raw ?? '').trim().toLowerCase()
  return MODES.includes(mode) ? mode : 'redline'
}

// load-bearing: a cloned repo can ship .omit or .omit/mode as a symlink, and
// writing through it would overwrite whatever file it points at.
export function writeMode(dir, mode) {
  const file = modeFile(dir)
  for (const p of [join(file, '..'), file]) {
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${p} is a symlink; not writing through it`)
  }
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, mode + '\n')
}

// An editorial objection, as the mode wants it: exit 2 to block; in margin, a
// systemMessage for the user and additionalContext for the model, exit 0.
export function object(dir, message, event) {
  const mode = readMode(dir)
  if (mode === 'off') process.exit(0)
  if (mode === 'margin') {
    const advisory = `omit (margin, advisory): ${message}`
    const context = event === 'PreToolUse' || event === 'PostToolUse' ? { hookSpecificOutput: { hookEventName: event, additionalContext: advisory } } : {}
    console.log(JSON.stringify({ systemMessage: advisory, ...context }))
    console.error(advisory)
    process.exit(0)
  }
  console.error(message)
  process.exit(2)
}
