// Destructive-command detection: the user's machine is load-bearing.
// Blocks the classic agent disasters before they execute: recursive deletes of
// home/system/drive roots, deletes through unset variables, disk overwrites,
// git commands that discard work or skip the hooks that check it, and TLS
// verification switched off to get past a certificate error.
// Suppress a reviewed command by appending: # omit-allow: <reason>
import { posix } from 'node:path'
import { isAllowSuppressed } from './hazards.mjs'
import { findTls } from './tls.mjs'

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

// `~/*` and `/*` empty the root as surely as naming it: the glob is stripped
// before the comparison, and a bare `/*` leaves the root itself.
const isProtected = (t) => {
  const bare = stripQuotes(t)
  return PROTECTED_TARGETS.some((re) => re.test(bare) || re.test(bare.replace(/[\\/]\*$/, '') || '/'))
}
const stripQuotes = (t) => t.replace(/^['"]|['"]$/g, '')
// `/./`, `/bin/..` and `~/.` name the same roots as `/` and `~`.
const canonical = (t) => {
  const m = /^(~|\$\{?HOME\}?)?(\/.*)$/.exec(t)
  return m ? (m[1] ?? '') + posix.normalize(m[2]).replace(/(.)\/$/, '$1') : t
}
// Words that run the command after them: `time rm -rf /` is `rm -rf /`.
const WRAPPERS = new Set(['sudo', 'time', 'env', 'command', 'builtin', 'nice', 'nohup', 'exec', 'then', 'do', 'else', '!'])

// unresolved variable at the head of a delete target: `rm -rf $OUT/*` nukes / when $OUT is empty
const VARIABLE_HEAD = /^['"]?(\$\{?\w+\}?|%\w+%|\$env:\w+)['"]?([\\/].*)?$/

function deleteTargets(segment) {
  const words = segment.trim().split(/\s+/)
  while (WRAPPERS.has(words[0]) || /^\w+=/.test(words[0] ?? '')) {
    words.shift()
    while (/^-|^\d+$/.test(words[0] ?? '')) words.shift()
  }
  // `… | xargs rm -rf` deletes whatever the pipe produced: no target on the
  // line to judge, so the recursive delete itself is the finding.
  let fromStdin = false
  if (words[0] === 'xargs') {
    fromStdin = true
    words.shift()
    while (words[0]?.startsWith('-')) words.shift()
  }
  // `\rm` skips an alias and `/bin/rm` names the binary: both are rm.
  const cmd = posix.basename((words[0] ?? '').replace(/^\\/, '')).toLowerCase().replace(/\.exe$/, '')
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
  return { recursive, targets, fromStdin }
}

export function assessCommand(command) {
  // A reviewed command is the one escape hatch this file needs: genuine ones
  // exist, and a human who has seen the target is the only judge of that. It is
  // not free text, though — the marker must be the trailing `#`/`//` comment
  // with a reason, so `rm -rf ~; echo "omit-allow:"` buys nothing.
  // omitted: any check that the user was really consulted — the sentinel's own
  // error text asks for that review, and a rule the machine cannot enforce is
  // not worth pretending to enforce.
  if (isAllowSuppressed(command)) return []
  // A backslash-newline is a space to the shell: `git reset \\⏎ --hard` is one command.
  command = command.replace(/\\\r?\n/g, ' ')
  const findings = []
  const push = (rule, reason) => findings.push({ rule, reason })
  // `sh -c "…"` runs its quoted text as a command: judge that text too, since
  // the quote blanking below would otherwise hide it.
  for (const m of command.matchAll(/\b(?:ba|z|da)?sh\s+-[a-z]*c\s+(["'])((?:(?!\1)[^\\]|\\.)*)\1/g)) findings.push(...assessCommand(m[2]))

  if (/dd\s+[^|;&]*of=\/dev\/(sd|hd|nvme|disk|mmcblk)/.test(command)) push('disk-overwrite', 'dd writing directly to a block device')
  if (/\bmkfs(\.\w+)?\b/.test(command)) push('disk-format', 'mkfs formats a filesystem')
  if (/\b(format)\s+[a-z]:/i.test(command)) push('disk-format', 'formatting a drive')
  if (/\bdiskpart\b/i.test(command)) push('disk-format', 'diskpart can repartition disks')
  if (/:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/.test(command)) push('fork-bomb', 'fork bomb')
  if (/\bfind\s+(\/|~|\$HOME)[^|;&]*(-delete|-exec\s+rm)/.test(command)) push('find-delete-root', 'find -delete sweeping a protected root')
  if (/\b(chmod|chown)\s+(-[a-z]*R[a-z]*\s+)[^|;&]*\s(\/|~|\$HOME)\s*$/im.test(command)) push('recursive-perms-root', 'recursive permission change on a protected root')

  if (/\bfind(?:\s+\.[\\/]?)?(?:\s+-(?:mindepth|maxdepth)\s+\d+)*\s+(?:-delete|-exec\s+rm\b)/.test(command)) {
    push('find-delete-cwd', 'find -delete with no filter predicate empties the working directory; add -name/-path/-type to say what goes')
  }
  for (const rule of findTls(command)) push(`tls-${rule}`, 'switches off TLS certificate verification')

  // Quoted spans are blanked so a commit message saying "--no-verify" is text,
  // not a flag; a quoted single word is unquoted first, since `git "push"` is a push.
  for (const segment of command.replace(/"([\w.+:/=-]*)"|'([\w.+:/=-]*)'/g, (_, a, b) => a ?? b).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').split(/&&|\|\||;|\||\n/)) {
    if (!/\bgit\b/.test(segment)) continue
    // The subcommand is the first word after git's own options, so `git log --grep commit -n 5` is a log.
    const sub = (name) => /\bgit(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+([\w-]+)/.exec(segment)?.[1] === name
    if (sub('clean') && /\s(?:-[a-zA-Z]*f|--force\b)/.test(segment) && !/\s(?:-[a-zA-Z]*n|--dry-run)\b/.test(segment)) push('git-clean', '`git clean -f` deletes untracked files, which git cannot bring back; preview with `git clean -n` and delete named paths')
    if (sub('reset') && /\s--hard\b/.test(segment)) push('git-reset-hard', '`git reset --hard` discards uncommitted work for good; `git stash` keeps it recoverable')
    if ((sub('checkout') || sub('restore')) && /\s(?:--\s+)?(?:\.[\\/]?|\*)(?=\s|$)/.test(segment) && !(/\s--staged\b/.test(segment) && !/\s(?:--worktree|-W)\b/.test(segment))) push('git-discard-all', 'discards every uncommitted change in the tree; restore named files instead')
    if ((sub('checkout') || sub('switch')) && /\s(?:-f|--force|--discard-changes)(?=\s|$)/.test(segment)) push('git-discard-all', '`git checkout -f` / `git switch -f` throw away uncommitted changes to switch; commit or stash them first')
    if (sub('push') && /\s(?:--force|-[a-zA-Z]*f[a-zA-Z]*|\+\S+)(?=\s|$)/.test(segment)) push('git-force-push', 'force-push rewrites the remote and can drop others\' commits; use --force-with-lease')
    // git takes any unambiguous prefix: `--no-veri` is --no-verify.
    if (/\s--no-veri\w*\b/.test(segment) || (sub('commit') && /\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$)/.test(segment))) push('hook-bypass', '--no-verify skips the hooks that check this commit, the omit gate among them')
    if (/\bconfig\b[^\n]*\bcore\.hooksPath\s+\S/i.test(segment)) push('hook-bypass', 'redirecting core.hooksPath moves git away from the hooks that check this commit')
  }

  // Read before blanking: `-c "core.hooksPath=/x"` hides the setting in quotes.
  if (/\bgit\b[^\n]*\s-c\s+['"]?core\.hooksPath=/i.test(command)) push('hook-bypass', 'redirecting core.hooksPath moves git away from the hooks that check this commit')

  // Every place a new command can start: separators, `&`, a newline, a
  // subshell, a brace group, a command substitution.
  for (const segment of command.split(/&&|\|\||[;&|\n()`]|\$\(|(?:^|\s)[{}](?=\s|$)/)) {
    const { recursive, targets, noPreserveRoot, fromStdin } = deleteTargets(segment)
    if (noPreserveRoot) {
      push('no-preserve-root', '`--no-preserve-root` exists only to delete the root filesystem')
      continue
    }
    if (recursive && fromStdin) push('xargs-delete', 'recursive delete of whatever paths arrive on stdin; an empty or unexpected line deletes the wrong tree')
    if (!recursive || !targets) continue
    for (const t of targets) {
      const bare = stripQuotes(t)
      if (isProtected(canonical(bare))) push('protected-root-delete', `recursive delete of protected path: ${bare}`)
      else if (CWD_WIPE.test(bare)) push('cwd-wipe', `recursive delete of the entire working directory (${bare}); delete specific paths instead`)
      else if (VARIABLE_HEAD.test(bare) && !/^\$\{\w+:?[-?]/.test(bare) && !/^\$\{?HOME\}?[\\/][^*\s]/.test(bare)) {
        push('unset-variable-delete', `recursive delete through a variable (${bare}); if it is empty or unset this can hit / or the home directory. Use \${VAR:?} or check it first`)
      }
    }
  }
  return findings
}
