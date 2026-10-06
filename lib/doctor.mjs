import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { probe } from './git.mjs'

// Read-only: never execute discovered hook commands to test their health.
export function doctor(cwd, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const findings = []
  const seen = new Set()
  const files = [...new Set([join(codexHome, 'hooks.json'), join(cwd, '.codex', 'hooks.json'), join(cwd, '.claude', 'settings.json')])]
  for (const file of files) {
    if (!existsSync(file)) { findings.push({ level: 'info', file, message: 'No hooks file.' }); continue }
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      if (!doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) throw new Error('invalid hooks object')
      for (const [event, groups] of Object.entries(doc.hooks)) {
        if (!Array.isArray(groups)) throw new Error('invalid hook groups')
        for (const group of groups) {
          if (!Array.isArray(group.hooks)) throw new Error('invalid hooks list')
          if (group.matcher) {
            try { new RegExp(group.matcher) } catch { findings.push({ level: 'error', file, message: `${event}: invalid matcher.` }) }
            if (/exec_command|^exec$|^shell$/.test(group.matcher) && !group.matcher.includes('Bash')) findings.push({ level: 'warning', file, message: `${event}: shell matcher lacks canonical Bash; verify harness aliases.` })
          }
          for (const hook of group.hooks) {
            if (hook.type !== 'command') { findings.push({ level: 'info', file, message: `${event}: non-command hook not inspected.` }); continue }
            if (typeof hook.command !== 'string') throw new Error('missing hook command')
            const key = `${event}\0${group.matcher ?? ''}\0${hook.command}`
            if (seen.has(key)) findings.push({ level: 'warning', file, message: `${event}: duplicate hook registration.` })
            seen.add(key)
            const match = /^(?:\S*\/)?(?:node|python3?)\s+(?:"([^"$]+)"|'([^']+)'|([^\s$;|&]+))\s*$/.exec(hook.command)
            if (!match) { findings.push({ level: 'info', file, message: `${event}: command shape not statically checked.` }); continue }
            const script = match[1] ?? match[2] ?? match[3]
            const path = isAbsolute(script) ? script : resolve(cwd, script)
            findings.push({ level: existsSync(path) ? 'info' : 'error', file, message: `${event}: script ${existsSync(path) ? 'exists' : 'missing'}: ${path}` })
            if (existsSync(path) && path.endsWith('.py')) {
              const source = readFileSync(path, 'utf8')
              const names = /^TOOL_NAMES\s*=\s*\{([^}\n]*)\}/m.exec(source)?.[1]
              if (names && /['"](?:exec|exec_command|shell)['"]/.test(names) && !/['"]Bash['"]/.test(names)) {
                findings.push({ level: 'warning', file, message: `${event}: literal Python TOOL_NAMES omits Bash; synthetic payload testing recommended.` })
              }
            }
          }
        }
      }
    } catch { findings.push({ level: 'error', file, message: 'Unreadable or malformed hooks configuration.' }) }
  }
  const git = probe(cwd, ['config', '--get', 'core.hooksPath'])
  if (git.ok && git.out.trim()) findings.push({ level: 'warning', message: 'core.hooksPath overrides the repository .git/hooks directory.' })
  return { liveDelivery: 'unverified', scope: 'global Codex and current-directory Codex/Claude hook files; selected script existence and Git routing', findings }
}
