// Lint bridge: omit ships no linter. It detects the one the repo already
// configured (omission 2: use what exists) and makes its errors unskippable.
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { execDisabled } from './exec.mjs'

export { execDisabled }

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

// Characters cmd.exe re-expands inside what looks like a quoted argument, plus
// the quote and newlines. An argv carrying one never reaches a Windows shim.
const WIN_UNSAFE = /[&|<>^()%"!\r\n]/

// Windows ships `npx` as npx.cmd, which CreateProcess refuses to start: it needs
// cmd.exe. Resolve the shim here so that decision is visible instead of implied.
function resolveShim(cmd, env) {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (env.PATH || '').split(';').filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      const path = join(dir, cmd + ext)
      if (existsSync(path)) return path
    }
  }
  return null
}

// What we hand the OS, as a plan a test can inspect. `shell` is false on every
// platform, always: this argv's tail is filenames from `git diff`, and `shell:
// true` concatenates them back into a command line for the OS to re-parse — so a
// PR file named `a&b.js` becomes two commands, and the diff author picks the
// second one. A .cmd shim is the one case that needs a shell at all, so it gets
// an explicitly built, verbatim line, and the run is refused outright if any
// argument carries a character that line could not survive as data.
// Exported for the test that pins this; not part of the module's API.
export function spawnPlan(cmd, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { cmd, args, shell: false }
  const shim = resolveShim(cmd, env)
  if (shim && !/\.(cmd|bat)$/i.test(shim)) return { cmd: shim, args, shell: false }
  // Trailing `\` would escape the closing quote of a quoted token.
  if (args.some((a) => WIN_UNSAFE.test(a) || /\\$/.test(a))) return null
  const line = [shim ?? cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
  return { cmd: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], shell: false, verbatim: true }
}

function runLinter(cmd, args, cwd) {
  const plan = spawnPlan(cmd, args)
  if (!plan) return { refused: true }
  return spawnSync(plan.cmd, plan.args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    shell: plan.shell,
    windowsVerbatimArguments: plan.verbatim === true,
    maxBuffer: 16 << 20,
  })
}

// Runs every detected linter over the files it applies to.
//
// Four outcomes, kept apart because the caller is the one making a claim about
// the repo: `ok` and `fail` (it ran), `unavailable` (configured, but there was
// nothing to run it with) and `not-run` (execution is off). Collapsing the
// middle two into "no results" let `rm -rf node_modules` turn an unrun linter
// into `no linter configured` — a false claim about the repo, printed by the
// agent's own tool in the same breath as a green verdict.
//
// `ok` stays true for both not-ran states: it answers "is anything wrong", which
// is what every existing caller gates on. Render on `status` before claiming a
// pass — `ok` alone cannot tell a clean run from a linter that never started.
// omitted: a `no-match` entry for a configured linter with no file of its
// extension in the diff; that reads as an empty result today, same as no config.
export function lintFiles(cwd, files) {
  const results = []
  for (const l of detectLinters(cwd)) {
    const mine = files.filter((f) => l.exts.has(extname(f).toLowerCase()))
    if (mine.length === 0) continue
    if (execDisabled()) {
      results.push({ linter: l.name, status: 'not-run', ok: true, output: `not run: OMIT_NO_EXEC is set` })
      continue
    }
    const [cmd, ...args] = l.argv(mine)
    const r = runLinter(cmd, args, cwd)
    if (r.refused) {
      // Reached only on Windows, for a .cmd shim handed a name cmd.exe would re-parse.
      results.push({ linter: l.name, status: 'unavailable', ok: true, output: `not run: a filename carries shell characters` })
      continue
    }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    if (r.error || r.status === null) {
      results.push({ linter: l.name, status: 'unavailable', ok: true, output: out.trim() || `could not run: ${r.error?.code ?? 'no exit status'}` })
      continue
    }
    // The binary is missing, not the lint clean: npx exits nonzero and says so
    // on stderr. Reporting that as a lint failure would be a false objection.
    if (r.status !== 0 && /not found|command not found|npm error|npm ERR/i.test(out)) {
      results.push({ linter: l.name, status: 'unavailable', ok: true, output: out.trim().split('\n').slice(0, 30).join('\n') })
      continue
    }
    results.push({ linter: l.name, status: r.status === 0 ? 'ok' : 'fail', ok: r.status === 0, output: out.trim().split('\n').slice(0, 30).join('\n') })
  }
  return results
}
