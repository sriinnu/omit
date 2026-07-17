#!/usr/bin/env node
// omit bench: EXPERIMENTAL referee harness. Runs paired agentic tasks across
// arms (baseline / omit / any other rule file) and reports the metrics from
// benchmarks/METHODOLOGY.md with full per-run logs. No numbers without receipts.
//
//   node bench/run.mjs bench/bench.config.json
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isManifest, addedDeps } from '../lib/deps.mjs'
import { findHazards } from '../lib/hazards.mjs'

const configPath = process.argv[2]
if (!configPath) {
  console.error('usage: node bench/run.mjs <config.json>   (see bench.config.example.json)')
  process.exit(1)
}
const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
const benchRoot = join(dirnameOf(import.meta.url), 'runs', String(Date.now()))
mkdirSync(benchRoot, { recursive: true })

function dirnameOf(url) {
  return join(fileURLToPath(url), '..')
}
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const results = []
for (const task of cfg.tasks) {
  for (const arm of cfg.arms) {
    const dir = mkdtempSync(join(tmpdir(), `omit-bench-`))
    cpSync(resolve(task.repo), dir, { recursive: true })
    if (arm.rules) cpSync(resolve(arm.rules), join(dir, arm.rulesDest ?? 'AGENTS.md'))
    if (!existsSync(join(dir, '.git'))) {
      sh('git init -q && git add -A && git -c user.email=bench@omit -c user.name=bench commit -qm base', dir)
    }

    console.log(`▶ ${task.id} × ${arm.name}`)
    const t0 = Date.now()
    // {prompt} in agentArgs is replaced inline; if absent, the prompt goes to stdin
    // (safer quoting, and `claude -p` reads stdin in print mode).
    const inline = cfg.agentArgs.some((a) => a.includes('{prompt}'))
    const run = spawnSync(cfg.agentCmd, cfg.agentArgs.map((a) => a.replaceAll('{prompt}', task.prompt)), {
      cwd: dir,
      encoding: 'utf8',
      input: inline ? undefined : task.prompt,
      timeout: (cfg.timeoutMinutes ?? 20) * 60_000,
      shell: process.platform === 'win32',
    })
    const durationMs = Date.now() - t0

    // metrics vs the base commit
    let added = 0, deleted = 0, newDeps = [], hazards = []
    try {
      sh('git add -A', dir)
      for (const row of sh('git diff --cached --numstat', dir).split('\n').filter(Boolean)) {
        const [a, d, path] = row.split('\t')
        if (a === '-') continue
        added += +a
        deleted += +d
        if (isManifest(path)) newDeps.push(...addedDeps(basename(path), sh(`git diff --cached -- "${path}"`, dir)))
      }
      const addedLines = sh('git diff --cached', dir).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
      hazards = findHazards(addedLines)
    } catch {}

    let testPass = null
    if (task.testCmd) {
      const t = spawnSync(task.testCmd, { cwd: dir, shell: true, encoding: 'utf8', timeout: 10 * 60_000 })
      testPass = t.status === 0
    }

    const rec = { task: task.id, arm: arm.name, added, deleted, net: added - deleted, newDeps, hazards: hazards.length, testPass, durationMs, dir }
    results.push(rec)
    writeFileSync(join(benchRoot, `${task.id}--${arm.name}.log`), `${run.stdout ?? ''}\n--- stderr ---\n${run.stderr ?? ''}`)
    console.log(`   net ${rec.net >= 0 ? '+' : ''}${rec.net} · deps +${newDeps.length} · hazards ${rec.hazards} · tests ${testPass === null ? 'n/a' : testPass ? 'pass' : 'FAIL'} · ${(durationMs / 1000).toFixed(0)}s`)
  }
}

writeFileSync(join(benchRoot, 'results.json'), JSON.stringify(results, null, 2))

// summary table: metric medians per arm
const arms = [...new Set(results.map((r) => r.arm))]
const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null)
let table = `| metric | ${arms.join(' | ')} |\n|---|${arms.map(() => '---').join('|')}|\n`
for (const [label, pick] of [
  ['median net LOC', (r) => r.net],
  ['new deps (total)', null],
  ['test failures', null],
  ['hazards (total)', null],
]) {
  const cells = arms.map((a) => {
    const rs = results.filter((r) => r.arm === a)
    if (label === 'median net LOC') return med(rs.map(pick))
    if (label === 'new deps (total)') return rs.reduce((n, r) => n + r.newDeps.length, 0)
    if (label === 'test failures') return rs.filter((r) => r.testPass === false).length
    return rs.reduce((n, r) => n + r.hazards, 0)
  })
  table += `| ${label} | ${cells.join(' | ')} |\n`
}
writeFileSync(join(benchRoot, 'summary.md'), table)
console.log(`\n${table}\nfull transcripts and results: ${benchRoot}`)
