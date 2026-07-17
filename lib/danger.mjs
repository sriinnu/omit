// Destructive-command detection: the user's machine is load-bearing.
// Blocks the classic agent disasters before they execute: recursive deletes of
// home/system/drive roots, deletes through unset variables, disk overwrites.
// Suppress a reviewed command by appending: # omit-allow: <reason>

const PROTECTED_TARGETS = [
  /^\/+$/, // filesystem root
  /^~[\\/]?$/,
  /^\$HOME[\\/]?$/,
  /^\$\{HOME\}[\\/]?$/,
  /^%USERPROFILE%[\\/]?$/i,
  /^\$env:USERPROFILE[\\/]?$/i,
  /^[a-z]:[\\/]*$/i, // drive root
  /^[\\/](home|root|etc|usr|bin|sbin|boot|var|opt|users)[\\/]?$/i,
  /^[\\/](home|users)[\\/][^\\/]+[\\/]?$/i, // a user's home dir
  /^[a-z]:[\\/](users|windows|program files( \(x86\))?)[\\/]?$/i,
  /^[a-z]:[\\/]users[\\/][^\\/]+[\\/]?$/i, // a Windows profile
]

const CWD_WIPE = /^(\*|\.|\.\/|\.\\)$/

const isProtected = (t) => PROTECTED_TARGETS.some((re) => re.test(stripQuotes(t)))
const stripQuotes = (t) => t.replace(/^['"]|['"]$/g, '')

// unresolved variable at the head of a delete target: `rm -rf $OUT/*` nukes / when $OUT is empty
const VARIABLE_HEAD = /^['"]?(\$\{?\w+\}?|%\w+%|\$env:\w+)['"]?([\\/].*)?$/

function deleteTargets(segment) {
  const words = segment.trim().split(/\s+/)
  if (words[0] === 'sudo') words.shift()
  const cmd = (words[0] ?? '').toLowerCase().replace(/\.exe$/, '')
  let recursive = false
  let targets = []

  if (['rm'].includes(cmd)) {
    const flags = words.filter((w) => w.startsWith('-'))
    recursive = flags.some((f) => /^-[a-z]*r/i.test(f) || f === '--recursive')
    if (flags.includes('--no-preserve-root')) return { recursive: true, targets: ['/'], noPreserveRoot: true }
    targets = words.slice(1).filter((w) => !w.startsWith('-'))
  } else if (['rmdir', 'rd', 'del'].includes(cmd)) {
    recursive = words.some((w) => /^\/s$/i.test(w))
    targets = words.slice(1).filter((w) => !w.startsWith('/') || w.length > 2)
  } else if (['remove-item', 'ri'].includes(cmd)) {
    recursive = words.some((w) => /^-recurse/i.test(w))
    targets = words.slice(1).filter((w) => !w.startsWith('-'))
  }
  return { recursive, targets }
}

export function assessCommand(command) {
  if (/omit-allow:/.test(command)) return []
  const findings = []
  const push = (rule, reason) => findings.push({ rule, reason })

  if (/dd\s+[^|;&]*of=\/dev\/(sd|hd|nvme|disk|mmcblk)/.test(command)) push('disk-overwrite', 'dd writing directly to a block device')
  if (/\bmkfs(\.\w+)?\b/.test(command)) push('disk-format', 'mkfs formats a filesystem')
  if (/\b(format)\s+[a-z]:/i.test(command)) push('disk-format', 'formatting a drive')
  if (/\bdiskpart\b/i.test(command)) push('disk-format', 'diskpart can repartition disks')
  if (/:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/.test(command)) push('fork-bomb', 'fork bomb')
  if (/\bfind\s+(\/|~|\$HOME)[^|;&]*(-delete|-exec\s+rm)/.test(command)) push('find-delete-root', 'find -delete sweeping a protected root')
  if (/\b(chmod|chown)\s+(-[a-z]*R[a-z]*\s+)[^|;&]*\s(\/|~|\$HOME)\s*$/im.test(command)) push('recursive-perms-root', 'recursive permission change on a protected root')

  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const { recursive, targets, noPreserveRoot } = deleteTargets(segment)
    if (noPreserveRoot) {
      push('no-preserve-root', '`--no-preserve-root` exists only to delete the root filesystem')
      continue
    }
    if (!recursive || !targets) continue
    for (const t of targets) {
      const bare = stripQuotes(t)
      if (isProtected(bare)) push('protected-root-delete', `recursive delete of protected path: ${bare}`)
      else if (CWD_WIPE.test(bare)) push('cwd-wipe', `recursive delete of the entire working directory (${bare}); delete specific paths instead`)
      else if (VARIABLE_HEAD.test(bare) && !/^\$\{\w+:?[-?]/.test(bare)) {
        push('unset-variable-delete', `recursive delete through a variable (${bare}); if it is empty or unset this can hit / or the home directory. Use \${VAR:?} or check it first`)
      }
    }
  }
  return findings
}
