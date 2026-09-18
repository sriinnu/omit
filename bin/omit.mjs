#!/usr/bin/env node
// omit CLI: provider-neutral enforcement. Claude Code hooks, git pre-commit,
// CI, and any other agent's hook system all call the same commands.
//
//   omit init [agents|claude|cursor|cline|windsurf|all]   copy rule files into this repo
//   omit audit [--base <ref>] [--json|--markdown]         net diff, new deps, hazards
//   omit check <file...>                                  hazard-scan specific files
//   omit gate                                             audit the staged diff; fail on hazards/uncited deps
//   omit verify                                           re-check every claim in .omit/receipts.jsonl
//   omit leak "<cmd>"                                     would this command print a real secret to stdout?
//   omit hook install                                     add the gate to .git/hooks/pre-commit
//   omit hook install codex                                write .codex/hooks.json (live sentinels inside Codex CLI)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isManifest, addedDeps, unparsedDependencyFile } from '../lib/deps.mjs'
import { git, probe, repoRoot, fileAtRevision, GitError } from '../lib/git.mjs'
import { LEDGER, verifyLedger, newDepCitations } from '../lib/receipts.mjs'
import { findHazards } from '../lib/hazards.mjs'
import { lintFiles } from '../lib/lint.mjs'
import { assessCommand } from '../lib/danger.mjs'
import { assessLeak } from '../lib/leaks.mjs'

const cwd = process.cwd()
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- init ----------
const targets = {
  agents: [['AGENTS.md', 'AGENTS.md']],
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

// numstat rows. `-z` because a renamed path is otherwise printed as the brace
// composite `{old => new}/package.json` — not a path at all: `git show` and a
// filesystem read both fail on it, so both revisions of a rename commit read as
// empty and a dependency added there goes uncited. With -z the pre-image and
// post-image names arrive as separate fields:
//   ordinary  `A\tD\t<path>\0`
//   rename    `A\tD\t\0<old>\0<new>\0`
function parseNumstat(out) {
  const fields = out.split('\0')
  const rows = []
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i]
    if (!head) continue
    const [added, deleted, path] = head.split('\t')
    if (path === '') {
      const oldPath = fields[++i] ?? ''
      const newPath = fields[++i] ?? ''
      rows.push({ path: newPath, oldPath, added, deleted })
    } else {
      rows.push({ path, oldPath: path, added, deleted })
    }
  }
  return rows
}

// The added lines, which is the set every hazard rule reads — so it has to be all
// of them. A `startsWith('+++')` filter drops a real content line that begins
// with `++` (the patch prefixes it to `++++`), which hides a secret on that line
// and makes the count disagree with numstat. Skip the file header as a block.
function addedLinesOf(patch) {
  const added = []
  let header = true
  for (const l of patch.split('\n')) {
    if (l.startsWith('diff --git ')) {
      header = true
      continue
    }
    if (header) {
      // The block ends at the post-image header or the first hunk. Every other
      // header line (index, mode, similarity, rename) starts with neither, so
      // skipping the block cannot drop an added line.
      if (l.startsWith('+++ ') || l.startsWith('@@')) header = false
      continue
    }
    if (l.startsWith('+')) added.push(l.slice(1))
  }
  return added
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
  const lf = (s) => s.replace(/\r\n/g, '\n') // a CRLF checkout is not a different ledger
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

function collect(diffRange) {
  const root = rootOrDie()
  const staged = diffRange === '--cached'
  if (!staged) requireRevision(root, diffRange)

  const files = []
  const binaries = []
  let added = 0
  let countedAdded = 0
  let deleted = 0
  for (const row of parseNumstat(git(root, ['diff', '--numstat', '-z', '-M', diffRange]))) {
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
  if (!staged) {
    for (const path of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
      if (path.startsWith('.omit/')) continue // omit's own ledger, not the change
      const lines = readLines(root, path)
      if (!lines) continue // no text to count: a binary file adds no line to scan
      untracked.set(path, lines)
      files.push({ path, oldPath: path, added: lines.length, deleted: 0 })
      added += lines.length
    }
  }

  const patchAdded = addedLinesOf(git(root, ['diff', '-M', diffRange]))
  // numstat and the patch describe the same diff, so their added-line totals have
  // to agree. If they do not, part of the change went unread — and "scanned
  // nothing" must not be able to render as "found nothing".
  if (patchAdded.length !== countedAdded) {
    die(`the diff reports ${countedAdded} added lines but only ${patchAdded.length} could be read — refusing to report a verdict on a change that could not be read in full`)
  }

  const addedLines = [...patchAdded]
  for (const lines of untracked.values()) addedLines.push(...lines)

  // numstat calls a path binary: either it is one, or an attribute says so — and
  // the second is a way to erase a file from the scan. `src/config.js -diff` in
  // .git/info/attributes makes numstat report `-` and the patch carry no `+`
  // lines, so a committed secret renders as hazards: 0. The content is read
  // directly instead: how git chose to represent a file is a formatting decision,
  // and it must not decide whether the file is examined.
  for (const b of binaries) {
    const text = contentOf(root, b.path, staged)
    if (text === null) continue // gone from the index, or deleted: nothing left to scan
    files.push({ path: b.path, oldPath: b.oldPath, added: 0, deleted: 0, binary: true })
    addedLines.push(...splitLines(text))
  }

  // Dependencies are compared as parsed sets between the two revisions, so a
  // minified manifest is read the same as a pretty-printed one.
  const newDeps = []
  for (const f of files.filter((f) => isManifest(f.path))) {
    const before = manifestText(root, f.path, f.oldPath, staged ? 'HEAD' : diffRange)
    const after = manifestText(root, f.path, f.path, staged ? '' : null)
    newDeps.push(...addedDeps(basename(f.path), before, after).map((dep) => ({ dep, manifest: f.path })))
  }

  // Dependency-shaped files omit cannot parse — setup.py, build.gradle, a csproj.
  // A dependency added to one of those is invisible here, and an invisible
  // dependency renders as `new deps: 0 ✅`, which is a claim about a file nobody
  // read. It is reported, never failed: plenty of repos carry these for reasons
  // that have nothing to do with a dependency.
  const unparsed = [...new Set(files.map((f) => f.path).filter((p) => unparsedDependencyFile(p)))].sort()

  const hazards = findHazards(addedLines)
  const footnotes = addedLines.filter((l) => /omitted:/.test(l)).length
  const loadBearing = addedLines.filter((l) => /load-bearing:/.test(l)).length

  // A new dependency is cited only by a VERIFIED new-dep receipt. A ledger line
  // that merely names the dep is an assertion, and assertions are the thing this
  // mechanism exists to stop accepting.
  const ledger = ledgerForChange(root, staged)
  const uncitedDeps = newDeps.filter((d) => ledger.citations.get(d.dep)?.status !== 'verified')

  const lint = lintFiles(root, files.map((f) => f.path).filter((p) => existsSync(join(root, p))))

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
  if (baseIdx !== -1 && (!args[baseIdx + 1] || args[baseIdx + 1].startsWith('-'))) die('usage: omit audit [--base <ref>] [--json|--markdown]')
  const base = baseIdx !== -1 ? args[baseIdx + 1] : 'HEAD'
  const fmt = args.includes('--json') ? 'json' : args.includes('--markdown') ? 'markdown' : 'text'
  console.log(render(collect(base), fmt))
}

function gate() {
  const r = collect('--cached')
  console.log(render(r, 'text'))
  // A shadowed hooks directory is reported, not fatal: `core.hooksPath` is a
  // legitimate global setup (a hooks manager, a shared hooks repo), and failing
  // every commit over the user's own configuration would be a false objection.
  // The row above already says the gate omit installs is not the hook git runs;
  // `hook install` now writes where git actually looks, so the honest fix lives
  // there rather than in refusing to work.
  const secrets = r.hazards.filter((h) => h.type === 'secret')
  if (secrets.length) {
    console.error(`\n⛔ omit gate: ${secrets.length} secret(s) staged. Move to env/secrets manager, rotate if real, restage.`)
    process.exit(1)
  }
  if (r.receiptFailures.length) {
    console.error(
      `\n⛔ omit gate: ${r.receiptFailures.length} receipt(s) in ${LEDGER} did not survive their own check — a refuted claim is a fabricated citation:\n` +
        r.receiptFailures.map((f) => `  line ${f.at} (${f.claim ?? 'no claim'}): ${f.checks.filter((c) => c.ok === false).map((c) => c.detail).join('; ')}`).join('\n') +
        `\nFix the receipt or the code it cites, then re-run.`
    )
    process.exit(1)
  }
  if (r.uncitedDeps.length) {
    console.error(
      `\n⛔ omit gate: new dep(s) without a verified receipt: ${r.uncitedDeps.map((d) => d.dep).join(', ')}.` +
        (r.ledgerInChange
          ? ''
          : `\n   ${LEDGER} is not part of this commit — receipts are read from the index, so a ledger that is not being committed cites nothing.`) +
        `\nAdd one line to ${LEDGER} naming the dep and the omission you tried (each entry is re-checked, and must NOT hold):\n` +
        // The printed line has to be a receipt that verifies: a template whose
        // shape the checker rejects leaves an agent that followed it verbatim
        // blocked on its own instructions. `absent` names a symbol the checker
        // searches the whole tracked tree for, and the claim survives only if the
        // search comes back empty — so replace it with the symbol you actually
        // looked for.
        `  {"claim":"new-dep","rung":7,"dep":"${r.uncitedDeps[0].dep}","tried":[{"rung":2,"absent":"<symbol you searched for>"}]}\n` +
        `Run \`omit verify\` to check it before committing.`
    )
    process.exit(1)
  }
  if (r.hazards.length) {
    console.error(`\n⚠ omit gate: injection-prone lines staged. Parameterize, use safe APIs, or mark reviewed lines with omit-allow: <reason>.`)
    process.exit(1)
  }
  const lintFails = (r.lint ?? []).filter((l) => !l.ok)
  if (lintFails.length) {
    console.error(`\n⛔ omit gate: the repo's own linter is failing on staged files.\n${lintFails.map((l) => `[${l.linter}]\n${l.output}`).join('\n')}`)
    process.exit(1)
  }
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
  const findings = assessLeak(command)
  if (findings.length === 0) {
    console.log('ok')
    return
  }
  for (const f of findings) console.error(`[${f.rule}] ${f.reason}`)
  process.exit(1)
}

// Codex CLI's hook schema is the same shape as Claude Code's (confirmed against
// developers.openai.com/codex/hooks: PreToolUse fires with tool_input.command for
// Bash, exit 2 blocks). Command-sentinel and leak-sentinel run on that shape as-is.
// The PostToolUse file hooks (dep/hazard/lint-sentinel) and the Stop gate are wired
// too since Codex documents the same events, but Codex's apply_patch tool_input
// shape for PostToolUse isn't confirmed here — those three no-op safely if the
// file_path field isn't present, so this is best-effort, not verified parity.
function hookInstallCodex() {
  const dir = '.codex'
  const hooksPath = join(dir, 'hooks.json')
  mkdirSync(dir, { recursive: true })

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
      console.error(`omit: ${hooksPath} has a malformed "${event}" entry (expected an array of matcher groups) — fix or remove it first`)
      process.exit(1)
    }
  }

  const scriptCmd = (script) => `node "${join(pkgRoot, 'hooks', script)}"`
  const mergeHook = (event, matcher, script) => {
    doc.hooks[event] ??= []
    let group = doc.hooks[event].find((g) => g.matcher === matcher)
    if (!group) {
      group = { matcher, hooks: [] }
      doc.hooks[event].push(group)
    }
    const command = scriptCmd(script)
    if (!group.hooks.some((h) => h.command === command)) group.hooks.push({ type: 'command', command })
  }

  mergeHook('PreToolUse', 'Bash', 'command-sentinel.mjs')
  mergeHook('PreToolUse', 'Bash', 'leak-sentinel.mjs')
  mergeHook('PostToolUse', 'apply_patch|Edit|Write', 'dep-sentinel.mjs')
  mergeHook('PostToolUse', 'apply_patch|Edit|Write', 'hazard-sentinel.mjs')
  mergeHook('PostToolUse', 'apply_patch|Edit|Write', 'lint-sentinel.mjs')
  mergeHook('Stop', '', 'final-draft-gate.mjs')

  writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${hooksPath}`)
  console.log('  verified against Codex\'s documented schema: command sentinel + leak sentinel run on Bash commands (same tool_input.command shape as Claude Code)')
  console.log('  best-effort, unverified: dep/hazard/lint sentinels + Final Draft gate on apply_patch/Edit/Write — they no-op safely if the field shape differs, report back if you see them miss real edits')
  console.log('\nCodex requires trusting new hook definitions once per session: run `/hooks` in Codex to review, or start with --dangerously-bypass-hook-trust for unattended runs.')
}

// Where git actually looks for hooks. With `core.hooksPath` set — a global
// setup many people run — `.git/hooks/pre-commit` is never executed, so writing
// there would print success while nothing enforced anything.
function hooksDir(root) {
  const r = probe(root, ['config', '--get', 'core.hooksPath'])
  const configured = r.ok ? r.out.trim() : ''
  if (!configured) return join('.git', 'hooks')
  return configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured
}

function hookInstall() {
  if (!existsSync('.git')) {
    console.error('omit: not a git repository')
    process.exit(1)
  }
  const dir = hooksDir(process.cwd())
  const hookPath = join(dir, 'pre-commit')
  if (existsSync(hookPath) && readFileSync(hookPath, 'utf8').includes('omit gate')) {
    console.log(`skip  pre-commit gate already installed at ${hookPath}`)
    return
  }
  if (!existsSync(dir)) {
    console.error(`omit: ${dir} does not exist — create it, or \`git config --unset core.hooksPath\``)
    process.exit(1)
  }
  const line = '\nnpx -y @sriinnu/omit gate || exit 1\n'
  if (existsSync(hookPath)) {
    writeFileSync(hookPath, readFileSync(hookPath, 'utf8') + line)
  } else {
    writeFileSync(hookPath, '#!/bin/sh' + line)
  }
  chmodSync(hookPath, 0o755)
  console.log(`wrote ${hookPath}: every commit now passes the omit gate, whatever agent wrote it`)
  if (dir !== join('.git', 'hooks')) console.log(`  (core.hooksPath is set, so this is where git runs hooks from — .git/hooks would have been ignored)`)
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
const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'audit') audit(rest)
  else if (cmd === 'gate') gate()
  else if (cmd === 'check') check(rest)
  else if (cmd === 'lint') lint(rest)
  else if (cmd === 'guard') guard(rest)
  else if (cmd === 'leak') leak(rest)
  else if (cmd === 'verify') verify()
  else if (cmd === 'hook' && rest[0] === 'install' && rest[1] === 'codex') hookInstallCodex()
  else if (cmd === 'hook' && rest[0] === 'install' && rest[1] === undefined) hookInstall()
  else if (cmd === 'hook' && rest[0] === 'install') {
    console.error(`omit: unrecognized 'hook install' target '${rest[1]}' — usage: omit hook install [codex]`)
    process.exit(1)
  }
  else if (cmd === 'init') init(rest[0])
  else if (targets[cmd]) init(cmd) // back-compat: `omit cursor`
  else {
    console.error('usage: omit <init|audit|check|gate|lint|guard|leak|verify|hook install|hook install codex>')
    process.exit(cmd ? 1 : 0)
  }
} catch (e) {
  if (!(e instanceof GitError)) throw e
  die(`git could not answer: ${e.message}\nNothing was checked. Fix the repository state (or the revision named), then re-run.`)
}
