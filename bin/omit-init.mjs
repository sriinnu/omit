#!/usr/bin/env node
// Installs omit's rule files into the current repo. Zero dependencies — rung 3 of our own ladder.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const targets = {
  agents: [['AGENTS.md', 'AGENTS.md']],
  claude: [[join('skills', 'omit', 'SKILL.md'), join('.claude', 'skills', 'omit', 'SKILL.md')]],
  cursor: [[join('.cursor', 'rules', 'omit.mdc'), join('.cursor', 'rules', 'omit.mdc')]],
  cline: [[join('.clinerules', 'omit.md'), join('.clinerules', 'omit.md')]],
  windsurf: [[join('.windsurf', 'rules', 'omit.md'), join('.windsurf', 'rules', 'omit.md')]],
}
targets.all = Object.values(targets).flat()

const pick = process.argv[2] ?? 'agents'
if (!targets[pick]) {
  console.error(`usage: omit [${Object.keys(targets).join('|')}]   (default: agents)`)
  process.exit(1)
}

for (const [src, dest] of targets[pick]) {
  if (existsSync(dest)) {
    console.log(`skip  ${dest} (already exists — will not overwrite)`)
    continue
  }
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(join(pkgRoot, src), dest)
  console.log(`wrote ${dest}`)
}
console.log('\nDraft less. Cite everything. Cut last.')
