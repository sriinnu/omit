#!/usr/bin/env node
// omit CLI: provider-neutral enforcement. Claude Code hooks, git pre-commit,
// CI, and any other agent's hook system all call the same commands.
//
//   omit init [agents|claude|cursor|cline|windsurf|all]   copy rule files into this repo
//   omit audit [--base <ref>] [--json|--markdown]         net diff, new deps, hazards, score
//   omit check <file...>                                  hazard-scan specific files
//   omit gate                                             audit the staged diff; fail on hazards/uncited deps
//   omit hook install                                     add the gate to .git/hooks/pre-commit
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isManifest, addedDeps } from '../lib/deps.mjs'
import { findHazards } from '../lib/hazards.mjs'
import { lintFiles } from '../lib/lint.mjs'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (args) => execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

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
function collect(diffRange) {
  const numstat = git(`diff --numstat ${diffRange}`).split('\n').filter(Boolean)
  const files = []
  let added = 0
  let deleted = 0
  for (const row of numstat) {
    const [a, d, path] = row.split('\t')
    if (a === '-') continue // binary
    files.push({ path, added: +a, deleted: +d })
    added += +a
    deleted += +d
  }

  const newDeps = []
  for (const f of files.filter((f) => isManifest(f.path))) {
    const diff = git(`diff ${diffRange} -- "${f.path}"`)
    newDeps.push(...addedDeps(basename(f.path), diff).map((dep) => ({ dep, manifest: f.path })))
  }

  const fullDiff = git(`diff ${diffRange}`)
  const addedLines = fullDiff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
  const hazards = findHazards(addedLines)
  const footnotes = addedLines.filter((l) => /omitted:/.test(l)).length
  const loadBearing = addedLines.filter((l) => /load-bearing:/.test(l)).length

  let receipts = ''
  if (existsSync('.omit/receipts.jsonl')) receipts = readFileSync('.omit/receipts.jsonl', 'utf8')
  const uncitedDeps = newDeps.filter((d) => !receipts.includes(d.dep))

  const lint = lintFiles(process.cwd(), files.map((f) => f.path).filter((p) => existsSync(p)))

  return { files, added, deleted, net: added - deleted, newDeps, uncitedDeps, hazards, footnotes, loadBearing, lint }
}

function scoreOf(r) {
  let s = 100
  if (r.net > 0) s -= Math.min(30, Math.round(r.net / 25))
  s -= 15 * r.newDeps.length
  s -= Math.min(40, 25 * r.hazards.filter((h) => h.type === 'secret').length + 10 * r.hazards.filter((h) => h.type === 'injection').length)
  s += Math.min(10, 2 * r.footnotes)
  s -= Math.min(20, 10 * r.files.filter((f) => f.added > 300).length)
  s -= Math.min(20, 10 * (r.lint ?? []).filter((l) => !l.ok).length)
  return Math.max(0, Math.min(100, s))
}

function render(r, fmt) {
  const score = scoreOf(r)
  const light = score >= 85 ? '🟢' : score >= 60 ? '🟡' : '🔴'
  if (fmt === 'json') return JSON.stringify({ ...r, score }, null, 2)
  const rows = [
    `net: +${r.added} −${r.deleted} lines across ${r.files.length} file${r.files.length === 1 ? '' : 's'}`,
    `new deps: ${r.newDeps.length}${r.newDeps.length ? ': ' + r.newDeps.map((d) => d.dep).join(', ') : ' ✅'}${r.uncitedDeps.length ? ` (${r.uncitedDeps.length} without receipts ⚠)` : ''}`,
    `hazards: ${r.hazards.length === 0 ? '0 ✅' : r.hazards.map((h) => `${h.type}:${h.rule}`).join(', ') + ' ⛔'}`,
    `footnotes: ${r.footnotes} recorded · load-bearing: ${r.loadBearing} marked`,
    `lint: ${!r.lint || r.lint.length === 0 ? 'no linter configured' : r.lint.every((l) => l.ok) ? r.lint.map((l) => l.linter).join(', ') + ' ✅' : r.lint.filter((l) => !l.ok).map((l) => l.linter).join(', ') + ' failing ⛔'}`,
    `omit score: ${score}/100 ${light}`,
  ]
  if (fmt === 'markdown') return `### omit verdict\n\n${rows.map((x) => `- ${x}`).join('\n')}\n`
  return `omit verdict\n────────────\n${rows.join('\n')}`
}

function audit(args) {
  const baseIdx = args.indexOf('--base')
  const base = baseIdx !== -1 ? args[baseIdx + 1] : 'HEAD'
  const fmt = args.includes('--json') ? 'json' : args.includes('--markdown') ? 'markdown' : 'text'
  console.log(render(collect(base), fmt))
}

function gate() {
  const r = collect('--cached')
  console.log(render(r, 'text'))
  const secrets = r.hazards.filter((h) => h.type === 'secret')
  if (secrets.length) {
    console.error(`\n⛔ omit gate: ${secrets.length} secret(s) staged. Move to env/secrets manager, rotate if real, restage.`)
    process.exit(1)
  }
  if (r.uncitedDeps.length) {
    console.error(`\n⛔ omit gate: new dep(s) without receipts: ${r.uncitedDeps.map((d) => d.dep).join(', ')}. Append citations to .omit/receipts.jsonl or drop them.`)
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
  if (!files.length) {
    files = git('diff --name-only HEAD').split('\n').filter(Boolean)
    try {
      files.push(...git('ls-files --others --exclude-standard').split('\n').filter(Boolean))
    } catch {}
    files = files.filter((f) => existsSync(f))
  }
  const results = lintFiles(process.cwd(), files)
  if (results.length === 0) {
    console.log('omit lint: no configured linter applies to these files')
    return
  }
  for (const r of results) console.log(`[${r.linter}] ${r.ok ? 'pass ✅' : `fail ⛔\n${r.output}`}`)
  process.exit(results.some((r) => !r.ok) ? 1 : 0)
}

function hookInstall() {
  const hookPath = join('.git', 'hooks', 'pre-commit')
  if (!existsSync('.git')) {
    console.error('omit: not a git repository')
    process.exit(1)
  }
  if (existsSync(hookPath) && readFileSync(hookPath, 'utf8').includes('omit gate')) {
    console.log('skip  pre-commit gate already installed')
    return
  }
  const line = '\nnpx -y @sriinnu/omit gate || exit 1\n'
  if (existsSync(hookPath)) {
    writeFileSync(hookPath, readFileSync(hookPath, 'utf8') + line)
  } else {
    writeFileSync(hookPath, '#!/bin/sh' + line)
  }
  chmodSync(hookPath, 0o755)
  console.log('wrote .git/hooks/pre-commit: every commit now passes the omit gate, whatever agent wrote it')
}

// ---------- dispatch ----------
const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'audit') audit(rest)
else if (cmd === 'gate') gate()
else if (cmd === 'check') check(rest)
else if (cmd === 'lint') lint(rest)
else if (cmd === 'hook' && rest[0] === 'install') hookInstall()
else if (cmd === 'init') init(rest[0])
else if (targets[cmd]) init(cmd) // back-compat: `omit cursor`
else {
  console.error('usage: omit <init|audit|check|gate|lint|hook install>')
  process.exit(cmd ? 1 : 0)
}
