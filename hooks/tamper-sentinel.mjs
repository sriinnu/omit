#!/usr/bin/env node
// PreToolUse hook: the agent under check may not disarm the check. Every other
// sentinel is a hook registered in a file the agent can write, and the mode
// that decides whether they block is a file too. So this objects to:
//
//   - an edit that removes or rewrites omit's hooks in .claude/settings*.json,
//     .codex/hooks.json, .ribhu/hooks.json or .git/hooks/*, or that adds a
//     kill switch (disableAllHooks, an OMIT_OFF env) to one of them (any other
//     edit to those files passes: they hold permissions and other hooks too)
//   - any write to .omit/mode, and `omit mode <m>` run as a tool call: the
//     mode is the user's to set, with `/omit <mode>` or `! omit mode <mode>`
//   - any write to .git/config (core.hooksPath) or .git/omit/ (the session
//     baseline the Stop gate measures the change against)
//
// A shell command naming one of those files with a write shape is blocked
// whole: what it will write cannot be read off the command line.
import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { MAX_COMMAND, TOO_LONG, isAllowSuppressed } from '../lib/hazards.mjs'
import { proposedText } from '../lib/proposed.mjs'

if (process.env.OMIT_OFF === '1') process.exit(0)

// Exit 2 blocks; a crash at any other code is the tool call going through.
const block = (message) => {
  console.error(message)
  process.exit(2)
}

// Case-insensitive, because WSL's /mnt/c, macOS and Windows read .CLAUDE as .claude.
const HOOK_FILE = /(?:^|[\\/])(?:\.claude[\\/]settings(?:\.local)?\.json|\.codex[\\/]hooks\.json|\.ribhu[\\/]hooks\.json|\.git[\\/]hooks[\\/][^\\/\s'"]+)$/i
const MODE_FILE = /(?:^|[\\/])\.omit[\\/]mode$/i
const GIT_STATE = /(?:^|[\\/])\.git[\\/](?:config|omit[\\/][^\\/]+)$/i
// Also: the protected directories named whole (`rm -rf .claude`), a glob or
// expansion at their top level (`> .claude/set*.json`), and the kill switches.
const HOOK_FILE_IN_TEXT =
  /\.claude[\\/]settings(?:\.local)?\.json|\.codex[\\/]hooks\.json|\.ribhu[\\/]hooks\.json|\.git[\\/](?:hooks|config|omit)\b|\.omit[\\/]mode\b|(?:^|[\s'"=])(?:\.[\\/])?\.(?:claude|codex|ribhu|omit|git)(?:[\\/]hooks)?[\\/]?(?=[\s'";&|)]|$)|\.(?:claude|codex|ribhu|omit)[\\/][^\s;&|\\/]*[*?[{$]|\.git[\\/]h[^\s;&|\\/]*[*?[{$]|\bOMIT_OFF\b|\bdisableAllHooks\b/i
// A glob in the directory name itself (`rm -r .cla*`) is matched against these.
const PROTECTED_PATHS = ['.claude', '.claude/settings.json', '.claude/settings.local.json', '.codex', '.codex/hooks.json', '.ribhu', '.ribhu/hooks.json', '.omit', '.omit/mode', '.git', '.git/hooks', '.git/config', '.git/omit']
const globHits = (s) =>
  s.split(/\s+/).some((w) => {
    if (!/[*?[]/.test(w)) return false
    const re = new RegExp('^' + w.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '/?$', 'i')
    return PROTECTED_PATHS.some((p) => re.test(p))
  })
// An interpreter reading code from -e/-c, stdin or a heredoc can write any
// file it names, wherever the separators in its code fall.
const INTERPRETER = /\b(?:node|python[\d.]*|ruby|perl|php|deno|bun)\b[^\n]*?(?:\s-[a-zA-Z]*[ecE]\b|\s-(?=\s|$)|<<)/// `cd .claude && echo {} > settings.json` names no file: the cd is the tell.
const CD_PROTECTED = /\bcd\s+['"]?(?:\S*[\\/])?\.(?:claude|codex|ribhu|omit|git)\b/i
const WRITE_SHAPE = />|\btee\b|\bsed\b[^|;&\n]*\s-i|\bperl\s+-[a-z]*i|\b(?:cp|mv|rm|ln|unlink|truncate|chmod|install)\b|\b(?:node|python3?|ruby)\s+-[ec]\b|\bgit\s+(?:checkout|restore)\b|\bdd\b|\b(?:ex|n?vim?)\s/
const MODE_COMMAND = /\bomit(?:\.mjs)?\s+mode\s+\S/
// What marks a line in a hooks file as omit's. Fewer after the edit than
// before means one of omit's hooks went away.
const OMIT_MARK = /@sriinnu\/omit|omit gate|[\w-]+-sentinel\.mjs|final-draft-gate|ribhu-adapter|session-baseline|mode-prompt/g
const marks = (text) => (text.match(OMIT_MARK) ?? []).length
const KILL_SWITCH = /disableAllHooks|OMIT_OFF/

// What an edit must leave in place: in a JSON hooks file, each omit hook as
// (event, matcher, command), so a rewritten command, a changed matcher or a
// renamed "hooks" key all count as removal; elsewhere, each line naming omit.
// null when the text is not JSON: a hooks file that no longer parses has
// dropped every hook in it.
function omitHooks(text, json) {
  if (!json) return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => marks(l) > 0)
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const out = []
  for (const [event, groups] of Object.entries(doc?.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : [g]) {
        if (typeof h?.command === 'string' && marks(h.command) > 0) out.push(`${event}\0${g.matcher ?? ''}\0${h.command}`)
      }
    }
  }
  return out
}
const killed = (text, json) => {
  if (!json) return KILL_SWITCH.test(text)
  try {
    const doc = JSON.parse(text)
    return doc?.disableAllHooks === true || (doc?.env && typeof doc.env === 'object' && 'OMIT_OFF' in doc.env)
  } catch {
    return false
  }
}

const MODE_MSG =
  'omit blocks this: .omit/mode sets how hard omit enforces, and it is the user\'s to set, not the agent\'s.\n' +
  'Ask the user. They can type `/omit <margin|redline|rewrite|off>`, or run `! omit mode <mode>`.'
const GIT_STATE_MSG =
  'omit blocks this: .git/config sets which hooks git runs, and .git/omit holds the baseline the Stop gate measures this session against.\n' +
  'The agent may not write either: ask the user.'
const hooksMsg = (file) =>
  `omit blocks this: it would remove omit's hooks from ${file}, which switches off the checks on this session.\n` +
  'That is the user\'s call, not the agent\'s: ask them, and they can edit the file themselves.'

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

let data
try {
  data = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0) // harness-authored payload we cannot read: not evidence about an edit
}

try {
  const ti = data.tool_input ?? {}
  const cwd = data.cwd ?? process.cwd()

  if (data.tool_name === 'apply_patch') {
    const patch = typeof ti.command === 'string' ? ti.command : ''
    const holdsOmit = new Map()
    let target = null
    // Line-level: under a hooks file that holds omit's hooks, a removed line
    // naming omit, or the file deleted or moved away, takes a hook out.
    for (const line of patch.split(/\r?\n/)) {
      const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
      const moveTo = line.startsWith('*** Move to: ') ? line.slice('*** Move to: '.length).trim() : null
      if (header) target = header[2].trim()
      if (MODE_FILE.test(moveTo ?? target ?? '')) block(MODE_MSG)
      if (target === null || !HOOK_FILE.test(target)) continue
      if (!holdsOmit.has(target)) holdsOmit.set(target, marks(readText(resolve(cwd, target)) ?? '') > 0)
      if (holdsOmit.get(target) && (header?.[1] === 'Delete' || moveTo !== null || (line.startsWith('-') && marks(line) > 0))) block(hooksMsg(target))
      if (line.startsWith('+') && KILL_SWITCH.test(line)) block(hooksMsg(target))
    }
    process.exit(0)
  }

  const rawFile = typeof ti.file_path === 'string' ? ti.file_path : typeof ti.notebook_path === 'string' ? ti.notebook_path : null
  if (rawFile !== null) {
    // `.omit//mode` and `.omit/./mode` are .omit/mode.
    const file = posix.normalize(rawFile.replace(/\\/g, '/'))
    if (MODE_FILE.test(file)) block(MODE_MSG)
    if (GIT_STATE.test(file)) block(GIT_STATE_MSG)
    if (!HOOK_FILE.test(file)) process.exit(0)
    const current = readText(resolve(cwd, file))
    // An edit shape that cannot be read is an edit nobody checked.
    const after = proposedText(ti, current ?? '')
    const json = file.endsWith('.json')
    // A kill switch counts in any hooks file, even a new one: it silences the plugin's hooks too.
    if (after === null ? KILL_SWITCH.test(JSON.stringify(ti)) : killed(after, json) && !killed(current ?? '', json)) block(hooksMsg(file))
    if (current === null || marks(current) === 0) process.exit(0) // nothing of omit's there to remove
    const before = omitHooks(current, json)
    const kept = after === null ? null : omitHooks(after, json)
    if (kept === null || (before ?? []).some((h) => !kept.includes(h))) block(hooksMsg(file))
    process.exit(0)
  }

  if (typeof ti.command !== 'string') process.exit(0)
  if (ti.command.length > MAX_COMMAND) block(TOO_LONG)
  if (isAllowSuppressed(ti.command)) process.exit(0)
  // Read as the shell and the filesystem will: a backslash-newline is a space,
  // and `.omit//mode`, `.omit/./mode` are .omit/mode.
  const command = ti.command.replace(/\\\r?\n/g, ' ').replace(/([\\/])\.(?=[\\/])/g, '$1').replace(/([\\/])[\\/]+/g, '$1')
  if (MODE_COMMAND.test(command)) block(MODE_MSG)
  // Per segment, so reading a hooks file and writing elsewhere on one line passes.
  // A separator inside quotes does not end the command.
  const segments = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (m) => m.replace(/[;&|\n]/g, ' ')).split(/&&|\|\||[;|\n]/)
  // `2>/dev/null`, `2>&1`: a redirect that writes no file is not a write.
  const writeShape = (s) => WRITE_SHAPE.test(s.replace(/\d*>>?\s*(?:&\s*\d+|\/dev\/null\b)/g, ''))
  const writes =
    segments.some((s) => (HOOK_FILE_IN_TEXT.test(s) || globHits(s)) && writeShape(s)) ||
    (CD_PROTECTED.test(command) && writeShape(command)) ||
    (INTERPRETER.test(command) && (HOOK_FILE_IN_TEXT.test(command) || globHits(command)))
  if (writes) {
    block(
      'omit blocks this command: it writes to a hooks file, .omit/mode, .git/config or .git/omit, and what it writes cannot be read off the command line.\n' +
        'Removing or rerouting omit\'s hooks is the user\'s call: ask them. After genuine review with the user, append: # omit-allow: <reason>'
    )
  }
} catch (e) {
  block(
    `omit could not check this call for hook tampering (${e?.message ?? e}).\n` +
      'Blocking it rather than waving it through: a check that did not run is not a check that passed.'
  )
}
