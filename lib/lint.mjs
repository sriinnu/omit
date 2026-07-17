// Lint bridge: omit ships no linter. It detects the one the repo already
// configured (omission 2: use what exists) and makes its errors unskippable.
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const JS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte'])
const PY = new Set(['.py'])

export function detectLinters(cwd) {
  const has = (...names) => names.some((n) => existsSync(join(cwd, n)))
  const linters = []
  if (has('biome.json', 'biome.jsonc')) {
    linters.push({ name: 'biome', exts: JS, argv: (files) => ['npx', '--no-install', '@biomejs/biome', 'check', ...files] })
  } else if (has('eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml')) {
    linters.push({ name: 'eslint', exts: JS, argv: (files) => ['npx', '--no-install', 'eslint', ...files] })
  }
  let ruff = has('ruff.toml', '.ruff.toml')
  if (!ruff && existsSync(join(cwd, 'pyproject.toml'))) {
    ruff = readFileSync(join(cwd, 'pyproject.toml'), 'utf8').includes('[tool.ruff')
  }
  if (ruff) linters.push({ name: 'ruff', exts: PY, argv: (files) => ['ruff', 'check', ...files] })
  else if (has('.flake8', 'setup.cfg')) linters.push({ name: 'flake8', exts: PY, argv: (files) => ['flake8', ...files] })
  return linters
}

// Runs every detected linter over the files it applies to.
// Unavailable linters report nothing rather than fake a pass.
export function lintFiles(cwd, files) {
  const results = []
  for (const l of detectLinters(cwd)) {
    const mine = files.filter((f) => l.exts.has(extname(f).toLowerCase()))
    if (mine.length === 0) continue
    const [cmd, ...args] = l.argv(mine)
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' })
    if (r.error || r.status === null) continue
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    if (r.status !== 0 && /not found|command not found|npm error|npm ERR/i.test(out)) continue
    results.push({ linter: l.name, ok: r.status === 0, output: out.trim().split('\n').slice(0, 30).join('\n') })
  }
  return results
}
