import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const digest = text => createHash('sha256').update(text).digest('hex')

// Advisory heuristics only: shell syntax is not parsed or rewritten here.
export function readWarnings(command) {
  if (typeof command !== 'string') return []
  const warnings = []
  if (/\b(cat|rg|grep|find)\b/.test(command) && /(?:node_modules|\.git|coverage|\*\*|\$HOME|~\/)/.test(command)) {
    warnings.push('Broad read: scope the search to source paths and exclude generated directories.')
  }
  if (/^\s*cat\s+[^|;>]+$/.test(command)) warnings.push('Whole-file read: prefer a targeted range or search when only part of the file is needed.')
  if (/\b(?:rg|grep|find)\b.*\s\.(?:\s|$)/.test(command) && !/\|\s*(?:head|tail)\b/.test(command)) warnings.push('Repository-wide read: choose a source subdirectory or bound the returned matches.')
  return warnings
}

export function preview(text, limit = 6000) {
  if (text.length <= limit) return null
  // Preserve some diagnostic lines even when the failure sits in the middle.
  const diagnostics = (text.match(/^.*\b(?:error|failed|failure|fatal)\b.*$/gim) ?? []).join('\n').slice(0, Math.floor(limit / 5))
  const remaining = limit - diagnostics.length
  const head = Math.ceil(remaining / 2)
  return { head: text.slice(0, head), tail: text.slice(-(remaining - head)), diagnostics, omitted: text.length - remaining }
}

// load-bearing: private, owner-controlled storage; never follow an existing symlink.
export function existingSessionDir(cwd, session) {
  const path = join(tmpdir(), `omit-context-${process.getuid?.() ?? 'user'}-${digest(`${cwd}\0${session}`).slice(0, 32)}`)
  try { mkdirSync(path, { mode: 0o700 }) } catch (e) {
    if (e.code !== 'EEXIST') throw e
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('unsafe context storage')
  }
  return path
}

export function archiveText(dir, text) {
  const path = join(dir, `${randomUUID()}.txt`)
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 })
  return path
}

export function repeatCount(dir, key) {
  const path = join(dir, 'repeat.json')
  let previous = {}
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('unsafe repeat state')
    previous = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  const count = previous.key === key ? Math.min((previous.count || 0) + 1, 1000000) : 1
  const temporary = join(dir, `${randomUUID()}.json`)
  writeFileSync(temporary, JSON.stringify({ key, count }), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
  return count
}
