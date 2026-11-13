#!/usr/bin/env node
// omit CLI: provider-neutral enforcement. Claude Code hooks, git pre-commit,
// CI, and any other agent's hook system all call the same commands.
//
//   omit init [agents|claude|cursor|cline|windsurf|all]   copy rule files into this repo
//   omit audit [--base <ref>|--session] [--json|--markdown] [--fail-on <none|secret|hazard|gate>]  net diff, new deps, hazards
//   omit init --check                                     report rule files that drifted from this omit version
//   omit check <file...>                                  hazard-scan specific files
//   omit gate [--range <base>..<head>|--base <ref>] [--json]  audit the staged diff, or every commit in a range with the base's adoption and mode. Always blocks secrets and TLS bypass; injection, uncited deps, refuted receipts and lint only in repos that adopted omit (.omit/ tracked, or git config omit.enforce true), per mode
//   omit verify                                           re-check every claim in .omit/receipts.jsonl
//   omit leak "<cmd>"                                     would this command print a real secret to stdout?
//   omit hook install                                     add the gate to .git/hooks/pre-commit
//   omit hook install codex                                write .codex/hooks.json (live sentinels inside Codex CLI)
//   omit hook install ribhu                               write .ribhu/hooks.json (live sentinels inside Ribhu)
//   omit hook run <hook>                                  run one of omit's hooks on the payload on stdin
//   omit mode [margin|redline|rewrite|off]                print the enforcement mode, or set it
//   omit codemode run [file]                              run one sandboxed script over read-only repo tools (stdin without a file)
//   omit codemode                                         the same, as an MCP server on stdio
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isManifest, addedDeps, unparsedDependencyFile } from '../lib/deps.mjs'
import { git, probe, repoRoot, fileAtRevision, GitError, parseNumstat, readBaseline, snapshotTree, addedLinesOf } from '../lib/git.mjs'
import { LEDGER, verifyLedger, newDepCitations } from '../lib/receipts.mjs'
import { findHazards, isInjectionExempt, MAX_COMMAND, TOO_LONG } from '../lib/hazards.mjs'
import { lintFiles, lintIndex } from '../lib/lint.mjs'
import { assessCommand } from '../lib/danger.mjs'
import { assessLeak } from '../lib/leaks.mjs'
import { execute, serve } from '../lib/codemode.mjs'
import { doctor } from '../lib/doctor.mjs'
import { DESCRIBE, MODES, readMode, writeMode, offMisspelled, parseMode } from '../lib/mode.mjs'
import { execDisabled } from '../lib/exec.mjs'
import { decide, verdictOf, canonical } from '../lib/verdict.mjs'

const cwd = process.cwd()
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

// Every hook a hooks file may name. load-bearing: `hook run` imports by name,
// and a cloned repo's hooks file can carry any name, so only these ever run.
const HOOKS = ['command-sentinel', 'leak-sentinel', 'tamper-sentinel', 'dep-sentinel', 'hazard-sentinel', 'lint-sentinel', 'context-sentinel', 'final-draft-gate', 'session-baseline', 'mode-prompt', 'ribhu-adapter']
// `npx` runs omit from a cache it prunes, so a hooks file pointing into that
// cache breaks the day it is cleaned. Installed from there, a hook calls back
// through npx at this exact version instead.
const fromNpxCache = /[\\/]_npx[\\/]/.test(pkgRoot)
const hookCommand = (name, arg) =>
  (fromNpxCache ? `npx -y @sriinnu/omit@${version} hook run ${name}` : `node "${join(pkgRoot, 'hooks', name + '.mjs')}"`) + (arg ? ` ${arg}` : '')
// Which omit hook a command runs, whatever path or pinned version installed it,
// so a reinstall from elsewhere or an upgrade replaces the entry, not doubles it.
const hookIdentity = (command) => {
  const m = /(?:[\\/]hooks[\\/]|\bhook run )([\w-]+)(?:\.mjs)?"?(?:\s+([\w-]+))?\s*$/.exec(typeof command === 'string' ? command : '')
  return m && HOOKS.includes(m[1]) ? `${m[1]} ${m[2] ?? ''}` : null
}

// ---------- init ----------
const targets = {
  agents: [['AGENTS.md', 'AGENTS.md']],
  skill: [['skills/omit/SKILL.md', '.agents/skills/omit/SKILL.md']],
  claude: [[join('skills', 'omit', 'SKILL.md'), join('.claude', 'skills', 'omit', 'SKILL.md')]],
  cursor: [[join('.cursor', 'rules', 'omit.mdc'), join('.cursor', 'rules', 'omit.mdc')]],
  cline: [[join('.clinerules', 'omit.md'), join('.clinerules', 'omit.md')]],
  windsurf: [[join('.windsurf', 'rules', 'omit.md'), join('.windsurf', 'rules', 'omit.md')]],
  copilot: [[join('.github', 'copilot-instructions.md'), join('.github', 'copilot-instructions.md')]],
}
targets.codex = targets.agents // Codex reads AGENTS.md
targets.takumi = targets.agents // Takumi reads AGENTS.md
targets.all = [...new Set(Object.values(targets).flat())]

function init(pick = 'agents') {
  if (!targets[pick]) {
    console.error(`usage: omit init [${Object.keys(targets).join('|')}]   (default: agents)`)
    process.exit(1)
  }
  for (const [src, dest] of targets[pick]) {
    if (existsSync(dest)) {
      console.log(`skip  ${dest} (already exists: will not overwrite)`)
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(pkgRoot, src), dest)
    console.log(`wrote ${dest}`)
  }
  console.log('\nDraft less. Cite everything. Cut last.')
}

// init never overwrites, so an installed rule file can drift from the package
// forever without saying so. --check reports the drift and writes nothing;
// exit 1 lets CI notice a stale rule file the way it notices a stale pin.
function initCheck() {
  let drifted = 0
  for (const [src, dest] of targets.all) {
    if (!existsSync(dest)) {
      console.log(`missing  ${dest}`)
      continue
    }
    if (lf(readFileSync(dest, 'utf8')) === lf(readFileSync(join(pkgRoot, src), 'utf8'))) console.log(`current  ${dest}`)
    else {
      drifted++
      console.log(`drifted  ${dest} — differs from omit ${version}; init never overwrites, so review and update it by hand`)
    }
  }
  process.exitCode = drifted ? 1 : 0
}

// ---------- audit / gate ----------
const die = (msg) => {
  console.error(`omit: ${msg}`)
  process.exit(1)
}

// The repo root, resolved once and threaded through everything below. git prints
// and resolves `rev:path` against the ROOT, so a cwd-relative join reads the
// wrong tree the moment this runs from a subdirectory — and silently: the path is
// simply not found, and a file that is not found declares no dependencies.
function rootOrDie() {
  const root = repoRoot(cwd)
  if (!root) die('not a git repository — audit and gate measure a diff against git history')
  return root
}

const splitLines = (text) => {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const lf = (s) => s.replace(/\r\n/g, '\n') // a CRLF checkout is not a different file

// The blob the index holds for a path — the file as the commit would contain it,
// or null when the index does not hold it at all. Written as `:0:<path>` rather
// than `:<path>` because git reads `:.omit/receipts.jsonl` as a malformed
// revision and refuses to answer: for a path that is not staged, a refusal is
// indistinguishable from an absence, and the ledger lives under `.omit/`.
function indexText(root, path) {
  if (!path) return null
  const r = fileAtRevision(root, '', path)
  if (r.present) return r.text
  if (r.failed) die(`could not read ${path} from the index — ${r.reason}`)
  return null // not in the index: nothing there
}

// What a path actually holds: the working copy, or the index blob when the gate
// is judging a commit. null means there is genuinely nothing to read there (a
// deleted path); a git that cannot answer is an error, never an empty file.
function contentOf(root, path, staged) {
  if (staged) return indexText(root, path)
  try {
    return readFileSync(join(root, path), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    die(`could not read ${path} — ${e.message}`)
  }
}

// A file's lines, or null when it isn't text to be counted (binary, unreadable).
function readLines(root, path) {
  const text = contentOf(root, path, false)
  return text === null || text.includes('\0') ? null : splitLines(text)
}

// A file at a commit: its text, or null when that commit does not hold it.
function textAt(root, rev, path) {
  const r = fileAtRevision(root, rev, path)
  if (r.failed) die(`could not read ${path} at ${rev} — ${r.reason}`)
  return r.present ? r.text : null
}

function manifestText(root, path, oldPath, version) {
  if (version === '') return indexText(root, path) ?? '' // the index: what is being committed
  if (version !== null) {
    const r = fileAtRevision(root, version, oldPath)
    // A revision that could not be read is not "this manifest declares nothing".
    // That substitution is the difference between a new dependency and no new
    // dependency, made silently.
    if (r.failed) die(`could not read ${oldPath} at ${version} — ${r.reason}`)
    return r.present ? r.text : '' // deleted, or new here: declares nothing
  }
  return contentOf(root, path, false) ?? '' // deleted: declares nothing
}

// `--base` names a revision. An unresolvable one — a typo, a shallow clone, a
// force-push survivor — used to diff to nothing and render as a clean verdict,
// which is an audit of nothing reported as a pass. git would also read an
// unresolvable argument as a PATHSPEC and silently diff a directory, so it is
// resolved as a revision here rather than left to `git diff` to guess.
function requireRevision(root, range) {
  if (/\.\./.test(range)) die(`--base ${range}: expected a single revision — audit measures the change against one revision`)
  if (!probe(root, ['rev-parse', '--verify', '--quiet', `${range}^{commit}`]).ok) {
    die(`${range} is not a revision this repo can resolve — refusing to measure a change against nothing (no commits yet, a typo, a shallow clone, or a rewritten history?)`)
  }
}

// The receipts the gate weighs are the ones in the COMMIT, not the ones on disk.
// `--cached` judges the index, and a working-tree ledger the commit does not
// carry — or contradicts — verified nothing that ships: an untracked ledger used
// to cite a dependency while the commit contained no ledger at all.
function ledgerForChange(root, staged) {
  if (!staged) return { inChange: true, results: verifyLedger(root), citations: newDepCitations(root) }
  const stagedLedger = indexText(root, LEDGER)
  if (stagedLedger === null) return { inChange: false, citations: new Map(), results: [] }
  let disk = null
  try {
    disk = readFileSync(join(root, LEDGER), 'utf8')
  } catch {}
  if (disk === null || lf(disk) !== lf(stagedLedger)) {
    die(
      `the staged ${LEDGER} is not the file on disk — receipts are checked against the working tree, so a ledger that differs from the one being committed was never the one checked. Stage the same content, or restore it with \`git checkout -- ${LEDGER}\`.`
    )
  }
  return { inChange: true, results: verifyLedger(root), citations: newDepCitations(root) }
}

// `git config core.hooksPath /tmp/empty` disarms the pre-commit gate for good and
// leaves no trace in `git status` or in any diff. This is the only evidence there
// is, so it is read and reported rather than assumed absent.
// `--show-origin` because where it is set is what tells a machine-wide setting
// apart from `git config core.hooksPath /tmp/empty` run a moment ago.
function hooksPathAt(root) {
  const r = probe(root, ['config', '--show-origin', '--get', 'core.hooksPath'])
  if (!r.ok) return null
  const line = r.out.trim().replace(/\n.*$/, '')
  const tab = line.indexOf('\t')
  return tab === -1 ? { origin: '(unknown)', value: line } : { origin: line.slice(0, tab), value: line.slice(tab + 1) }
}

// `session` is the SessionStart baseline: the change is then baseline tree →
// a snapshot of the tree now, two trees, so an untracked file is already in the
// second one and pre-session dirt is in both. omit's own directory is left out
// by pathspec, so numstat and the patch still describe the same diff.
// `diffRange` is a revision (against the working tree), '--cached', or a
// { from, to } pair of commits — a commit's own change, which no working tree or
// index takes part in. `ledger` lets a range check receipts once, not per commit.
function collect(diffRange, session = null, { lint: wantLint = true, ledger: given = null } = {}) {
  const root = rootOrDie()
  const pair = typeof diffRange === 'object'
  const staged = diffRange === '--cached'
  if (!staged && !session && !pair) requireRevision(root, diffRange)
  const range = session ? [session.tree, snapshotTree(root), '--', '.', ':(exclude).omit'] : pair ? [diffRange.from, diffRange.to] : [diffRange]

  const files = []
  const binaries = []
  let added = 0
  let countedAdded = 0
  let deleted = 0
  for (const row of parseNumstat(git(root, ['diff', '--numstat', '-z', '-M', ...range]))) {
    if (row.added === '-') {
      binaries.push(row) // git says binary — read it by content below
      continue
    }
    files.push({ path: row.path, oldPath: row.oldPath, added: +row.added, deleted: +row.deleted })
    added += +row.added
    countedAdded += +row.added
    deleted += +row.deleted
  }

  // Untracked files are invisible to `git diff`, and a working tree mid-task is
  // mostly untracked: new files, not yet added. Counting them is the difference
  // between auditing the change and auditing only the part that got staged.
  // Excluded from the staged range — a gate judges what is being committed, and
  // an untracked file is not in the commit.
  const untracked = new Map()
  if (!staged && !session && !pair) {
    for (const path of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
      if (path.startsWith('.omit/')) continue // omit's own ledger, not the change
      const lines = readLines(root, path)
      if (!lines) continue // no text to count: a binary file adds no line to scan
      untracked.set(path, lines)
      files.push({ path, oldPath: path, added: lines.length, deleted: 0 })
      added += lines.length
    }
  }

  const patch = git(root, ['diff', '-M', ...range])
  const patchAdded = addedLinesOf(patch)
  // numstat and the patch describe the same diff, so their added-line totals have
  // to agree. If they do not, part of the change went unread — and "scanned
  // nothing" must not be able to render as "found nothing".
  if (patchAdded.length !== countedAdded) {
    die(`the diff reports ${countedAdded} added lines but only ${patchAdded.length} could be read — refusing to report a verdict on a change that could not be read in full`)
  }

  const addedLines = [...patchAdded]
  for (const lines of untracked.values()) addedLines.push(...lines)
  // The injection rules skip docs, vendored and generated files; secrets and TLS
  // bypass read every added line. `codeLines` is the subset the injection rules see.
  const codeLines = addedLinesOf(patch, (p) => !isInjectionExempt(p))
  for (const [path, lines] of untracked) if (!isInjectionExempt(path)) codeLines.push(...lines)

  // numstat calls a path binary: either it is one, or an attribute says so — and
  // the second is a way to erase a file from the scan. `src/config.js -diff` in
  // .git/info/attributes makes numstat report `-` and the patch carry no `+`
  // lines, so a committed secret renders as hazards: 0. The content is read
  // directly instead: how git chose to represent a file is a formatting decision,
  // and it must not decide whether the file is examined.
  for (const b of binaries) {
    const text = pair ? textAt(root, diffRange.to, b.path) : contentOf(root, b.path, staged)
    if (text === null) continue // gone from the index, or deleted: nothing left to scan
    files.push({ path: b.path, oldPath: b.oldPath, added: 0, deleted: 0, binary: true })
    addedLines.push(...splitLines(text))
    if (!isInjectionExempt(b.path)) codeLines.push(...splitLines(text))
  }

  // Dependencies are compared as parsed sets between the two revisions, so a
  // minified manifest is read the same as a pretty-printed one.
  const newDeps = []
  for (const f of files.filter((f) => isManifest(f.path))) {
    const before = pair ? textAt(root, diffRange.from, f.oldPath) ?? '' : manifestText(root, f.path, f.oldPath, staged ? 'HEAD' : session ? session.tree : diffRange)
    const after = pair ? textAt(root, diffRange.to, f.path) ?? '' : manifestText(root, f.path, f.path, staged ? '' : null)
    newDeps.push(...addedDeps(f.path, before, after).map((dep) => ({ dep, manifest: f.path })))
  }

  // Dependency-shaped files omit cannot parse — setup.py, build.gradle, a csproj.
  // A dependency added to one of those is invisible here, and an invisible
  // dependency renders as `new deps: 0 ✅`, which is a claim about a file nobody
  // read. It is reported, never failed: plenty of repos carry these for reasons
  // that have nothing to do with a dependency.
  const unparsed = [...new Set(files.map((f) => f.path).filter((p) => unparsedDependencyFile(p)))].sort()

  const hazards = [...findHazards(addedLines).filter((h) => h.type !== 'injection'), ...findHazards(codeLines).filter((h) => h.type === 'injection')]
  const footnotes = addedLines.filter((l) => /omitted:/.test(l)).length
  const loadBearing = addedLines.filter((l) => /load-bearing:/.test(l)).length

  // A new dependency is cited only by a VERIFIED new-dep receipt. A ledger line
  // that merely names the dep is an assertion, and assertions are the thing this
  // mechanism exists to stop accepting.
  const ledger = given ?? ledgerForChange(root, staged)
  const uncitedDeps = newDeps.filter((d) => ledger.citations.get(d.dep)?.status !== 'verified')

  // The gate lints the index, an audit lints the working tree; null is "not asked".
  const changed = files.map((f) => f.path)
  const lint = !wantLint ? null : staged ? lintIndex(root, changed) : lintFiles(root, changed.filter((p) => existsSync(join(root, p))))

  return {
    files,
    added,
    deleted,
    net: added - deleted,
    newDeps,
    unparsed,
    uncitedDeps,
    ledgerInChange: ledger.inChange,
    receipts: summarize(ledger.results),
    receiptFailures: ledger.results.filter((r) => r.status === 'failed'),
    hazards,
    footnotes,
    loadBearing,
    lint,
    hooksPath: hooksPathAt(root),
  }
}

// A linter that never started is neither a pass nor a failure, and `ok` alone
// cannot tell them apart: it stays true for `unavailable` (configured, nothing to
// run it with) and `not-run` (execution is off) so that `!ok` keeps meaning "the
// lint found something". Rendering on `ok` alone prints `eslint ✅` for a linter
// that never ran, which is a false pass — worse than the false "no linter
// configured" it replaced. So the verdict says which of the four it was.
// The reason a linter did not run, one line and short enough for a verdict row.
// `not run: X` is the entry's own phrasing and reads as a stutter under a "not
// run" label, so the prefix comes off.
const lintReason = (l) => (l.output ?? '').replace(/^not run: /, '').split('\n')[0].slice(0, 80)

const lintLine = (lint) => {
  if (lint === null) return 'skipped'
  if (!lint || lint.length === 0) return 'no linter configured'
  const ran = lint.filter((l) => l.status === 'ok' || l.status === 'fail')
  const idle = lint.filter((l) => l.status !== 'ok' && l.status !== 'fail')
  const parts = []
  const failing = ran.filter((l) => l.status === 'fail')
  if (failing.length) parts.push(`${failing.map((l) => l.linter).join(', ')} failing ⛔`)
  const passing = ran.filter((l) => l.status === 'ok')
  if (passing.length) parts.push(`${passing.map((l) => l.linter).join(', ')} ✅`)
  if (idle.length) parts.push(`${idle.map((l) => `${l.linter} ${l.status === 'not-run' ? 'not run' : 'unavailable'} (${lintReason(l)})`).join(' · ')} ⚠`)
  return parts.join(' · ')
}

const summarize = (rs) => ({
  total: rs.length,
  verified: rs.filter((r) => r.status === 'verified').length,
  failed: rs.filter((r) => r.status === 'failed').length,
  unverifiable: rs.filter((r) => r.status === 'unverifiable').length,
})

function render(r, fmt) {
  if (fmt === 'json') return JSON.stringify(r, null, 2)
  const binaries = r.files.filter((f) => f.binary).length
  const unparsed = r.unparsed ?? []
  const rows = [
    `net: +${r.added} −${r.deleted} lines across ${r.files.length} file${r.files.length === 1 ? '' : 's'}${binaries ? ` (${binaries} binary — scanned by content, git counts no lines)` : ''}`,
    // "0" with a ✅ next to it is the overclaim: where a dependency-shaped file
    // omit cannot read changed, nothing was counted AND nothing could be.
    r.newDeps.length || unparsed.length === 0
      ? `new deps: ${r.newDeps.length}${r.newDeps.length ? ': ' + r.newDeps.map((d) => d.dep).join(', ') : ' ✅'}${r.uncitedDeps.length ? ` (${r.uncitedDeps.length} without receipts ⚠)` : ''}`
      : `new deps: 0 (${unparsed.length} dependency-shaped file${unparsed.length === 1 ? '' : 's'} not parsed)`,
    `hazards: ${r.hazards.length === 0 ? '0 ✅' : r.hazards.map((h) => `${h.type}:${h.rule}`).join(', ') + ' ⛔'}`,
    `footnotes: ${r.footnotes} recorded · load-bearing: ${r.loadBearing} marked`,
    `receipts: ${r.receipts.total === 0 ? 'none recorded' : `${r.receipts.verified}/${r.receipts.total} verified${r.receipts.failed ? ` · ${r.receipts.failed} FAILED ⛔` : ''}${r.receipts.unverifiable ? ` · ${r.receipts.unverifiable} unverifiable ⚠` : ''}`}`,
    `lint: ${lintLine(r.lint)}`,
  ]
  if (unparsed.length) rows.push(`unparsed deps: ${unparsed.join(', ')} — dependency-shaped, omit does not parse ${unparsed.length === 1 ? 'it' : 'them'} ⚠`)
  if (r.hooksPath) rows.push(`hooks: core.hooksPath=${r.hooksPath.value} (set in ${r.hooksPath.origin}) — the pre-commit gate installed here is NOT the hook git runs ⛔`)
  if (fmt === 'markdown') return `### omit verdict\n\n${rows.map((x) => `- ${x}`).join('\n')}\n`
  return `omit verdict\n────────────\n${rows.join('\n')}`
}

function audit(args) {
  const baseIdx = args.indexOf('--base')
  if (baseIdx !== -1 && (!args[baseIdx + 1] || args[baseIdx + 1].startsWith('-'))) die('usage: omit audit [--base <ref> | --session] [--json|--markdown] [--fail-on <none|secret|hazard|gate>]')
  const base = baseIdx !== -1 ? args[baseIdx + 1] : 'HEAD'
  const fmt = args.includes('--json') ? 'json' : args.includes('--markdown') ? 'markdown' : 'text'
  // The verdict is advisory by default; --fail-on lets CI gate on it without a
  // second run (a second run would execute the ledger's snippets twice).
  const failIdx = args.indexOf('--fail-on')
  const failOn = failIdx !== -1 ? args[failIdx + 1] : 'none'
  if (!['none', 'secret', 'hazard', 'gate'].includes(failOn)) die('usage: omit audit [--base <ref> | --session] [--json|--markdown] [--fail-on <none|secret|hazard|gate>]')
  let session = null
  if (args.includes('--session')) {
    if (baseIdx !== -1) die('--session and --base name different starting points; pick one')
    session = readBaseline(rootOrDie())
    if (!session) die('no session baseline recorded — the SessionStart hook writes one (omit hook install claude). Use --base <ref> instead.')
  }
  const r = collect(base, session)
  console.log(render(r, fmt))
  // exitCode, not exit(): a piped stdout is async, and exit() would cut the verdict off.
  if ((failOn === 'secret' && r.hazards.some((h) => h.type === 'secret')) || (failOn === 'hazard' && r.hazards.length)) process.exitCode = 1
  if (failOn === 'gate') {
    // The gate's own decision, on this change, in this repo's mode and adoption.
    const mode = readMode(cwd)
    const d = decide(r, { mode, editorial: mode !== 'off' && adopted(rootOrDie()), scope: 'in this change' })
    for (const m of [...d.safety, ...d.objections]) console.error(`omit gate: ${m}`)
    if (!d.ok) process.exitCode = 1
  }
}

// A repo adopts omit's editorial checks by tracking `.omit/` (in HEAD or the
// index, so the commit that adds it is already judged) or with
// `git config omit.enforce true`; `false` opts out even then. Everything else is
// someone else's repo, where uncited deps and lint would be objections to a
// convention they never agreed to.
function adopted(root) {
  const flag = probe(root, ['config', '--type=bool', '--get', 'omit.enforce'])
  if (flag.ok) return flag.out.trim() === 'true'
  return [['ls-files', '--', '.omit'], ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.omit']].some((args) => probe(root, args).out?.trim())
}

// What the gate says, once the decision is made: the verdict (text or JSON) and
// the exit code. With --json stdout carries only the verdict object, so a CI step
// can diff it; every message goes to stderr either way.
function report({ d, verdict, fmt, text }) {
  if (fmt === 'json') console.log(canonical(verdict))
  else console.log(text)
  const block = !d.ok || d.objections.length > 0
  for (const m of d.safety) console.error(`\n⛔ omit gate: ${m}`)
  const marker = d.ok ? '⚠' : '⛔'
  for (const m of d.objections) console.error(`\n${marker} omit gate: ${m}`)
  if (block && d.ok) console.error('\n(margin mode: reported, not enforced)')
  // exitCode, not exit(): a piped stdout is async, and exit() would cut the verdict off.
  if (!d.ok) process.exitCode = 1
}

const skipNote = (mode) => `omit gate: editorial checks (injection, new deps, receipts, lint) skipped — ${mode === 'off' ? 'mode is off' : 'this repo has not adopted omit; opt in with \`git config omit.enforce true\` or by committing .omit/'}.`

function gate(args) {
  const fmt = args.includes('--json') ? 'json' : 'text'
  const range = args.indexOf('--range')
  const baseIdx = args.indexOf('--base')
  if (range !== -1 || baseIdx !== -1) return gateRange(args, fmt)
  const root = rootOrDie()
  const mode = readMode(cwd)
  const isAdopted = adopted(root)
  const editorial = mode !== 'off' && isAdopted
  const r = collect('--cached', null, { lint: editorial })
  // Safety: enforced in every repo and every mode, `off` included. A shadowed
  // hooks directory is reported, not fatal: `core.hooksPath` is a legitimate
  // global setup, and failing every commit over it would be a false objection.
  const d = decide(r, { mode, editorial })
  const head = probe(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const verdict = verdictOf({ version, base: head.ok ? head.out.trim() : null, head: 'index', adopted: isAdopted, mode, exec: !execDisabled(), r, editorial }, d)
  report({ d, verdict, fmt, text: render(r, 'text') })
  if (!editorial && d.ok) (fmt === 'json' ? console.error : console.log)(skipNote(mode))
}

// Every commit in base..head, judged with the BASE revision's adoption and mode:
// a change cannot loosen the gate that judges it by adding .omit/mode = off or by
// deleting .omit/. The environment's OMIT_MODE and git config's omit.enforce are
// not read either — only the base tree, so the same range gives the same verdict
// on a laptop and in CI. Each commit is diffed against its first parent, so a
// secret added in one commit and removed in the next still fails. A merge commit
// is judged only on the lines it adds relative to ALL its parents (git's combined
// diff), so a clean merge adds nothing and an incoming branch is not audited
// twice; omitted: new dependencies introduced by a merge itself (a merge that
// edits a manifest to add one) — add back if evil merges matter here.
// The working tree must be the range's head: receipts and the linter read it.
function gateRange(args, fmt) {
  const root = rootOrDie()
  const arg = (flag) => args[args.indexOf(flag) + 1]
  const spec = args.includes('--range') ? arg('--range') : `${arg('--base')}..HEAD`
  const m = (spec ?? '').split('..')
  if (m.length !== 2 || !m[0] || !m[1] || m[0].endsWith('.') || m[1].startsWith('.')) die('usage: omit gate --range <base>..<head> | --base <ref>   (two dots, two revisions)')
  const sha = (rev) => {
    const r = probe(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    if (!r.ok) die(`${rev} is not a revision this repo can resolve — refusing to gate a range that cannot be read (a shallow clone? fetch the full history)`)
    return r.out.trim()
  }
  const base = sha(m[0])
  const head = sha(m[1])
  if (head !== sha('HEAD')) die(`--range head ${m[1]} is not the checked-out commit — check it out first: receipts and lint read the working tree`)

  const isAdopted = git(root, ['ls-tree', '-r', '--name-only', base, '--', '.omit']).trim() !== ''
  const mode = parseMode(textAt(root, base, '.omit/mode')?.slice(0, 64))
  const editorial = mode !== 'off' && isAdopted
  const ledger = editorial ? ledgerForChange(root, false) : { inChange: true, results: [], citations: new Map() }

  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  const r = { hazards: [], uncitedDeps: [], receiptFailures: ledger.results.filter((x) => x.status === 'failed'), ledgerInChange: ledger.inChange, lint: null }
  const changed = new Set()
  const commits = git(root, ['rev-list', '--reverse', '--topo-order', `${base}..${head}`]).split('\n').filter(Boolean)
  for (const commit of commits) {
    const parents = git(root, ['rev-list', '--parents', '-n', '1', commit]).trim().split(' ').slice(1)
    let part
    if (parents.length > 1) {
      const lines = mergeNovelLines(root, commit)
      part = { hazards: [...findHazards(lines.all).filter((h) => h.type !== 'injection'), ...findHazards(lines.code).filter((h) => h.type === 'injection')], uncitedDeps: [], files: [] }
    } else {
      part = collect({ from: parents[0] ?? EMPTY_TREE, to: commit }, null, { lint: false, ledger })
    }
    r.hazards.push(...part.hazards.map((h) => ({ ...h, commit })))
    r.uncitedDeps.push(...part.uncitedDeps)
    for (const f of part.files) changed.add(f.path)
  }
  // The linter reads the checked-out head, so only files that survive into it.
  if (editorial) r.lint = lintFiles(root, [...changed].filter((p) => existsSync(join(root, p))).sort())

  const d = decide(r, { mode, editorial, scope: 'in the range' })
  const verdict = verdictOf({ version, base, head, adopted: isAdopted, mode, exec: !execDisabled(), r, editorial }, d)
  report({ d, verdict, fmt, text: `omit gate ${base.slice(0, 12)}..${head.slice(0, 12)}: ${commits.length} commit(s), mode ${mode}, ${isAdopted ? 'adopted' : 'not adopted'}, ${d.ok ? 'ok' : 'BLOCKED'}` })
  if (!editorial && d.ok) (fmt === 'json' ? console.error : console.log)(skipNote(mode))
}

// The lines a merge commit adds that none of its parents have: in git's combined
// diff, a hunk line is new relative to every parent only when all of its leading
// marker columns are '+'.
function mergeNovelLines(root, commit) {
  const all = []
  const code = []
  let path = null
  let columns = 0
  for (const l of git(root, ['diff-tree', '--cc', '-p', '--no-commit-id', '-r', commit]).split('\n')) {
    if (l.startsWith('diff --cc ') || l.startsWith('diff --combined ')) {
      path = l.replace(/^diff --(?:cc|combined) /, '')
      columns = 0
    } else if (l.startsWith('@@@')) columns = /^@+/.exec(l)[0].length - 1
    else if (columns && l.slice(0, columns) === '+'.repeat(columns)) {
      all.push(l.slice(columns))
      if (!isInjectionExempt(path)) code.push(l.slice(columns))
    }
  }
  return { all, code }
}

function check(files) {
  if (!files.length) {
    console.error('usage: omit check <file...>')
    process.exit(1)
  }
  let bad = false
  for (const f of files) {
    const findings = findHazards(readFileSync(f, 'utf8').split('\n'))
    for (const h of findings) {
      console.log(`${f}:${h.line}  ${h.type}  [${h.rule}]  ${h.text}`)
      bad = true
    }
  }
  process.exit(bad ? 1 : 0)
}

function lint(files) {
  // Files named on the command line are relative to where the caller stands; a
  // list derived from git is root-relative, because that is how git reports it.
  // Keep the two apart instead of resolving one against the other's base.
  let base = cwd
  if (!files.length) {
    base = rootOrDie()
    files = [
      ...git(base, ['diff', '--name-only', '-M', 'HEAD']).split('\n'),
      ...git(base, ['ls-files', '--others', '--exclude-standard']).split('\n'),
    ].filter((f) => f && existsSync(join(base, f)))
  }
  const results = lintFiles(base, files)
  if (results.length === 0) {
    console.log('omit lint: no configured linter applies to these files')
    return
  }
  for (const r of results) {
    // Same distinction as the verdict: a linter that did not run gets neither a
    // pass nor a failure, and exits 0 — it is unrun, not clean.
    if (!r.ok) console.log(`[${r.linter}] fail ⛔\n${r.output}`)
    else if (r.status === 'ok') console.log(`[${r.linter}] pass ✅`)
    else console.log(`[${r.linter}] not run ⚠ — ${lintReason(r)}`)
  }
  process.exit(results.some((r) => !r.ok) ? 1 : 0)
}

function guard(args) {
  const command = args.join(' ')
  if (!command) {
    console.error('usage: omit guard "<shell command>"')
    process.exit(1)
  }
  // The hooks refuse an unreadable command; the CLI entry points wire into other
  // hosts' hooks, so they carry the same bound rather than trusting the caller.
  if (command.length > MAX_COMMAND) die(TOO_LONG)
  const findings = assessCommand(command)
  if (findings.length === 0) {
    console.log('ok')
    return
  }
  for (const f of findings) console.error(`[${f.rule}] ${f.reason}`)
  process.exit(1)
}

function leak(args) {
  const command = args.join(' ')
  if (!command) {
    console.error('usage: omit leak "<shell command>"')
    process.exit(1)
  }
  if (command.length > MAX_COMMAND) die(TOO_LONG)
  const findings = assessLeak(command)
  if (findings.length === 0) {
    console.log('ok')
    return
  }
  for (const f of findings) console.error(`[${f.rule}] ${f.reason}`)
  process.exit(1)
}

// An existing hooks file is merged into, never replaced: someone else's hooks
// live there too. One that cannot be read is refused rather than overwritten.
function loadHooksDoc(hooksPath) {
  let doc = { hooks: {} }
  if (existsSync(hooksPath)) {
    try {
      doc = JSON.parse(readFileSync(hooksPath, 'utf8'))
    } catch {
      console.error(`omit: ${hooksPath} exists but isn't valid JSON — fix or remove it first`)
      process.exit(1)
    }
  }
  doc.hooks ??= {}
  for (const [event, entry] of Object.entries(doc.hooks)) {
    if (entry !== undefined && !Array.isArray(entry)) {
      console.error(`omit: ${hooksPath} has a malformed "${event}" entry (expected an array) — fix or remove it first`)
      process.exit(1)
    }
  }
  return doc
}

// Codex CLI's hook schema is the same shape as Claude Code's (confirmed against
// developers.openai.com/codex/hooks: PreToolUse fires with tool_input.command for
// Bash, exit 2 blocks). Command-sentinel and leak-sentinel run on that shape as-is.
// File sentinels extract surviving paths from Codex's apply_patch command.
// Contract tests cover these payloads; live harness delivery is a separate check.
function hookInstallCodex(options = [], host = 'codex') {
  if (options.some(option => option !== '--context')) die('usage: omit hook install codex [--context]')
  const dir = host === 'claude' ? '.claude' : '.codex'
  const hooksPath = join(dir, host === 'claude' ? 'settings.json' : 'hooks.json')
  mkdirSync(dir, { recursive: true })
  const doc = loadHooksDoc(hooksPath)

  const mergeHook = (event, matcher, name) => {
    doc.hooks[event] ??= []
    let group = doc.hooks[event].find((g) => g?.matcher === matcher)
    if (!group) {
      group = { matcher, hooks: [] }
      doc.hooks[event].push(group)
    }
    const command = hookCommand(name)
    const same = group.hooks.find((h) => hookIdentity(h?.command) === hookIdentity(command))
    if (same) same.command = command
    else group.hooks.push({ type: 'command', command })
  }

  if (host === 'claude') {
    // The plugin's own hooks.json is the one list of what runs under Claude
    // Code, so a project install cannot drift from the plugin. An older install
    // may carry omit's hooks under narrower or Codex-shaped matchers ("Bash",
    // "apply_patch|Edit|Write"); merging into those doubles every sentinel the
    // matchers share. So the omit hooks this run re-adds come out first — whatever
    // group holds them — and the plugin's list goes in. Everyone else's hooks
    // stay, and so do omit's opt-in ones this run does not re-add (context-sentinel
    // without --context).
    const plugin = JSON.parse(readFileSync(join(pkgRoot, 'hooks', 'hooks.json'), 'utf8'))
    const readded = new Set(Object.values(plugin.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => /hooks\/([\w-]+)\.mjs/.exec(h.command)[1]))))
    if (options.includes('--context')) readded.add('context-sentinel')
    for (const [event, groups] of Object.entries(doc.hooks)) {
      for (const g of groups) if (Array.isArray(g?.hooks)) g.hooks = g.hooks.filter((h) => !readded.has(hookIdentity(h?.command)?.split(' ')[0]))
      doc.hooks[event] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0)
    }
    for (const [event, groups] of Object.entries(plugin.hooks)) {
      for (const g of groups) for (const h of g.hooks) mergeHook(event, g.matcher, /hooks\/([\w-]+)\.mjs/.exec(h.command)[1])
    }
  } else {
    mergeHook('SessionStart', '', 'session-baseline')
    mergeHook('PreToolUse', 'Bash', 'command-sentinel')
    mergeHook('PreToolUse', 'Bash', 'leak-sentinel')
    mergeHook('PreToolUse', 'Bash', 'tamper-sentinel')
    mergeHook('PreToolUse', 'apply_patch|Edit|Write', 'tamper-sentinel')
    mergeHook('PostToolUse', 'Bash', 'dep-sentinel')
    mergeHook('PostToolUse', 'Bash', 'hazard-sentinel')
    mergeHook('PostToolUse', 'apply_patch|Edit|Write', 'dep-sentinel')
    mergeHook('PostToolUse', 'apply_patch|Edit|Write', 'hazard-sentinel')
    mergeHook('PostToolUse', 'apply_patch|Edit|Write', 'lint-sentinel')
    mergeHook('Stop', '', 'final-draft-gate')
  }
  if (options.includes('--context')) {
    mergeHook('PreToolUse', 'Bash', 'context-sentinel')
    mergeHook('PostToolUse', 'Bash', 'context-sentinel')
  }

  writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${hooksPath}`)
  if (host === 'claude') {
    console.log('  the same hooks the omit plugin registers: session baseline, /omit <mode>, command/leak/tamper before Bash, leak before Read/Grep,')
    console.log('  tamper/dependency/hazard before file edits, lint after them, the Final Draft gate on Stop and SubagentStop')
  } else {
    console.log('  verified against Codex\'s documented schema: command, leak and tamper sentinels run on Bash commands (same tool_input.command shape as Claude Code)')
    console.log('  file sentinels cover apply_patch/Edit/Write; dependency and hazard checks also cover Bash edits. Payload tests do not establish live Codex hook delivery.')
  }
  console.log(`\nReview the installed hooks in ${host}; installation does not prove live delivery.`)
}

// The gate goes in the repository's own hooks directory — always, never into
// `core.hooksPath`. That setting is global on most machines that use it (a
// hooks manager, a shared hooks repo), so writing there would install ONE
// pre-commit gate for EVERY repository on the machine when the user asked to
// gate this one. `hookInstall` reports the shadowing instead and leaves that
// choice to the user.
function hooksDir() {
  return join('.git', 'hooks')
}

// `core.hooksPath` and the file it came from, or null when it is not set.
function hooksPathShadow() {
  const r = probe(process.cwd(), ['config', '--show-origin', '--get', 'core.hooksPath'])
  if (!r.ok) return null
  const [origin, value] = r.out.trim().split('\t')
  return value ? { origin, value } : null
}

function hookInstall() {
  if (!existsSync('.git')) {
    console.error('omit: not a git repository')
    process.exit(1)
  }
  const dir = hooksDir()
  const hookPath = join(dir, 'pre-commit')
  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null
  // A bare `omit` on PATH skips npx's ~3s start and works offline; npx at this
  // exact version is the fallback. Either spelling counts as an installed gate.
  const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => {
    try {
      accessSync(join(d, 'omit'), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  const gateCmd = onPath ? 'omit gate' : `npx -y @sriinnu/omit@${version} gate`
  const GATE = /(?:npx -y @sriinnu\/omit(?:@[\w.-]+)?|(?<![\w@/.-])omit) gate\b/g
  if (existing !== null && GATE.test(existing)) {
    // An older pin keeps running that version's gate: move it to this one.
    const pinned = existing.replace(GATE, () => gateCmd)
    if (pinned === existing) return console.log(`skip  pre-commit gate already installed at ${hookPath}`)
    writeFileSync(hookPath, pinned)
    return console.log(`updated ${hookPath}: the pre-commit gate now runs omit ${version}`)
  }
  // Pinned: an unpinned npx runs whatever is latest on the registry at commit time.
  const line = `${gateCmd} || exit 1\n`
  if (existing === null) {
    writeFileSync(hookPath, '#!/bin/sh\n' + line)
  } else {
    // First, right after the shebang: appended, it never runs behind an existing `exit 0`.
    const shebang = /^#!.*\n?/.exec(existing)?.[0] ?? ''
    if (shebang && !/\b(?:sh|bash|dash|zsh)\b/.test(shebang)) {
      die(`${hookPath} is not a shell script (${shebang.trim()}). Run this from it before anything else:\n  ${line}`)
    }
    writeFileSync(hookPath, shebang + (shebang.endsWith('\n') || !shebang ? '' : '\n') + line + existing.slice(shebang.length))
  }
  chmodSync(hookPath, 0o755)
  console.log(`wrote ${hookPath}: every commit now passes the omit gate, whatever agent wrote it`)
  const shadow = hooksPathShadow()
  if (shadow) {
    console.log(
      `\n⚠ core.hooksPath is set to ${shadow.value} (${shadow.origin}), so git will not run ${hookPath}.\n` +
        '  omit installs into the repository, not into a global hooks directory: one gate for every\n' +
        '  repo on this machine is not what "install the gate here" means.\n' +
        `  To make this gate effective here:   git config core.hooksPath .git/hooks\n` +
        `  To use your global directory instead, add this line to ${shadow.value}/pre-commit:\n` +
        `    ${gateCmd} || exit 1`
    )
  }
}

// The manifests the working tree change touches, tracked or not. `verify` needs
// them because "no claims recorded" and "nothing to check" are not the same
// thing: a manifest that changed with no ledger at all is the case this
// mechanism exists to catch.
function changedManifests(root) {
  const out = new Set()
  for (const f of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')) if (f && isManifest(f)) out.add(f)
  if (probe(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) {
    for (const f of git(root, ['diff', '--name-only', '-M', 'HEAD']).split('\n')) if (f && isManifest(f)) out.add(f)
  }
  return [...out]
}

// Every claim in the ledger, re-checked. This is the command the whole receipts
// mechanism exists for: `verify` passes only when nothing was taken on faith.
function verify() {
  const root = repoRoot(cwd)
  const results = verifyLedger(root ?? cwd)
  if (results.length === 0) {
    const manifests = root ? changedManifests(root) : []
    if (manifests.length) {
      die(`no ${LEDGER}, but ${manifests.join(', ')} changed — a manifest change with no receipt is the thing this checks, and it used to read as "nothing to check". Record a receipt in ${LEDGER}, or revert the manifest change.`)
    }
    console.log(`omit verify: no ${LEDGER} — no claims recorded, nothing to check`)
    return
  }
  for (const r of results) {
    console.log(`${r.status === 'verified' ? '✅' : r.status === 'failed' ? '⛔' : '⚠ '} line ${String(r.at).padStart(3)}  ${r.status.padEnd(13)} ${r.claim ?? '(no claim)'}`)
    for (const c of r.checks) if (c.ok !== true) console.log(`        [${c.kind}] ${c.detail}`)
  }
  const s = summarize(results)
  console.log(`\n${s.verified}/${s.total} claims survived re-checking · ${s.failed} refuted · ${s.unverifiable} unverifiable`)
  if (s.failed || s.unverifiable) {
    console.error('omit verify: every claim has to survive its own check. A refuted one is a citation that does not hold; an unverifiable one is still a self-report.')
    process.exit(1)
  }
}

// ---------- dispatch ----------
// A git call that could not answer reaches here as a throw, and it exits non-zero
// on purpose: a verdict rendered from a diff that could not be read is the
// failure this whole contract exists to prevent, and a gate that cannot read the
// change has to block it rather than pass it.
// Ribhu's hooks.json is not Codex's. Each event holds a flat list of
// { matcher, command }, the matcher is a regex over Ribhu's own lowercase tool
// names, and the payload a command receives is shaped differently, so every
// entry runs a sentinel through hooks/ribhu-adapter.mjs. Ribhu's code mode
// sends each nested tool call through these same hooks, so a script's writes
// are checked like direct ones.
function hookInstallRibhu() {
  const dir = '.ribhu'
  const hooksPath = join(dir, 'hooks.json')
  mkdirSync(dir, { recursive: true })
  const doc = loadHooksDoc(hooksPath)

  const add = (event, matcher, sentinel, extra) => {
    const command = hookCommand('ribhu-adapter', sentinel)
    doc.hooks[event] ??= []
    const same = doc.hooks[event].find((h) => h?.matcher === matcher && hookIdentity(h.command) === hookIdentity(command))
    if (same) same.command = command
    else doc.hooks[event].push({ ...(matcher && { matcher }), command, ...extra })
  }
  // Anchored: Ribhu matches with an unanchored regex, and a bare `write`
  // would also catch todo_write.
  const files = 'edit|multi_edit|ast_edit|write'
  add('PreToolUse', '^bash$', 'command-sentinel')
  add('PreToolUse', '^bash$', 'leak-sentinel')
  add('PreToolUse', '^bash$', 'tamper-sentinel')
  add('PreToolUse', '^read$', 'leak-sentinel')
  add('PreToolUse', `^(${files})$`, 'tamper-sentinel')
  add('PostToolUse', `^(bash|${files})$`, 'dep-sentinel')
  add('PostToolUse', `^(bash|${files})$`, 'hazard-sentinel')
  // Ribhu gives a hook ten seconds unless told otherwise, and a linter on a
  // large repo takes longer; sixty is the most it allows.
  add('PostToolUse', `^(${files})$`, 'lint-sentinel', { timeoutMs: 60000 })
  add('Stop', undefined, 'final-draft-gate')

  writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${hooksPath}`)
  console.log('  command, leak and tamper sentinels before bash; leak before read; tamper before file edits; dependency + hazard sentinels after bash and file edits; lint after file edits; Final Draft gate on Stop')
  console.log("  checked against Ribhu's hook contract with real payload shapes; not yet verified firing inside a live Ribhu session")
  console.log('\nRibhu runs a repository\'s hooks only once the project is trusted.')
}

// ---------- mode ----------
// The user's way to set the mode from a shell (`! omit mode margin`). The
// tamper sentinel refuses this same command when the agent runs it.
function mode(args) {
  if (args.length > 1 || (args[0] !== undefined && !MODES.includes(args[0]))) die(`${args[0] === undefined || args.length > 1 ? '' : `unknown mode "${args[0]}". `}usage: omit mode [${MODES.join('|')}]`)
  if (args[0]) writeMode(cwd, args[0])
  const now = readMode(cwd)
  console.log(`omit mode: ${now}. ${DESCRIBE[now]}`)
  if (args[0] && now !== args[0]) console.log('  OMIT_OFF or OMIT_MODE in this environment overrides .omit/mode.')
  const off = offMisspelled()
  if (off !== null) console.error(`omit: OMIT_OFF=${off} does not disable the hooks — only the literal OMIT_OFF=1 does.`)
}

// ---------- codemode ----------
// The sandbox is an optional peer, loaded here and nowhere else: every other
// command has to keep working on a machine that never installed it.
async function codemode(args) {
  if (args.length && args[0] !== 'run') die('usage: omit codemode [run [file]]')
  let sandbox
  try {
    sandbox = await import('@earendil-works/pi-codemode')
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e
    die('omit codemode needs its sandbox, which is not installed. Run: npm install @earendil-works/pi-codemode (it needs Node 22.19 or newer)')
  }
  const root = realpathSync(cwd)
  // `run` is the whole feature for any agent that has a shell: one script in,
  // one answer out, no server to register. Exit 1 marks a failed or withheld
  // result, so a harness can tell it from an answer.
  if (args[0] === 'run') {
    const { text, isError } = await execute(readFileSync(args[1] ?? 0, 'utf8'), { CodemodeSandbox: sandbox.CodemodeSandbox, root })
    console.log(text)
    process.exitCode = isError ? 1 : 0
    return
  }
  serve({ sandbox, root, version })
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'audit') audit(rest)
  else if (cmd === 'gate') gate(rest)
  else if (cmd === 'check') check(rest)
  else if (cmd === 'lint') lint(rest)
  else if (cmd === 'guard') guard(rest)
  else if (cmd === 'leak') leak(rest)
  else if (cmd === 'verify') verify()
  else if (cmd === 'codemode') await codemode(rest)
  else if (cmd === 'context') {
    if (rest.length) die('usage: omit context < hook-payload.json')
    await import('../hooks/context-sentinel.mjs')
  }
  else if (cmd === 'doctor') {
    if (rest.some(arg => arg !== '--json')) die('usage: omit doctor [--json]')
    const report = doctor(cwd)
    console.log(rest.includes('--json') ? JSON.stringify(report, null, 2) : ['omit doctor (read-only; live delivery unverified)', ...report.findings.map(f => `${f.level}: ${f.message}`)].join('\n'))
    if (report.findings.some(f => f.level === 'error')) process.exitCode = 1
  }
  else if (cmd === 'mode') mode(rest)
  else if (cmd === 'hook' && rest[0] === 'run') {
    if (!HOOKS.includes(rest[1])) die(`usage: omit hook run <${HOOKS.join('|')}>`)
    await import(`../hooks/${rest[1]}.mjs`)
  }
  else if (cmd === 'hook' && rest[0] === 'install' && rest[1] === 'codex') hookInstallCodex(rest.slice(2))
  else if (cmd === 'hook' && rest[0] === 'install' && rest[1] === 'claude') hookInstallCodex(rest.slice(2), 'claude')
  else if (cmd === 'hook' && rest[0] === 'install' && rest[1] === 'ribhu') hookInstallRibhu()
  else if (cmd === 'hook' && rest[0] === 'install' && rest[1] === undefined) hookInstall()
  else if (cmd === 'hook' && rest[0] === 'install') {
    console.error(`omit: unrecognized 'hook install' target '${rest[1]}' — usage: omit hook install [codex|claude|ribhu]`)
    process.exit(1)
  }
  else if (cmd === 'init') rest[0] === '--check' ? initCheck() : init(rest[0])
  else if (targets[cmd]) init(cmd) // back-compat: `omit cursor`
  else {
    console.error('usage: omit <init [--check]|audit [--fail-on <none|secret|hazard|gate>]|check|gate [--range <base>..<head>] [--json]|lint|guard|leak|verify|mode|codemode|context|doctor [--json]|hook install [codex|claude|ribhu] [--context]|hook run <hook>>')
    process.exit(cmd ? 1 : 0)
  }
} catch (e) {
  if (!(e instanceof GitError)) throw e
  die(`git could not answer: ${e.message}\nNothing was checked. Fix the repository state (or the revision named), then re-run.`)
}
