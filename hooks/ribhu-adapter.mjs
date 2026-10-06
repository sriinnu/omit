#!/usr/bin/env node
// Ribhu's shell hooks hand a command a different payload from the one Claude
// Code and Codex do:
//
//   Ribhu:     { event, tool, input: { path | command, … }, cwd }
//   sentinels: { tool_input: { file_path | command, … }, cwd }
//
// The exit contract is the same on both sides: 2 blocks, and stderr is the
// reason. So this translates the payload, runs the named sentinel on it, and
// hands back that sentinel's own status and reason. The sentinels are not
// touched, which means an objection raised under Ribhu is the same code as
// one raised under Claude Code, and so is every nested call a Ribhu code-mode
// script makes: those go through the same hooks as a direct call.
//
//   node ribhu-adapter.mjs <sentinel>     payload on stdin
//
// omitted: hook_event_name, tool_name and tool_response: no sentinel reads
// them today; translate them with the first one that does.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// load-bearing: the sentinel name comes from a hooks.json, and a cloned repo
// can carry one. Only these six files are ever run, never a path.
const SENTINELS = new Set(['command-sentinel', 'leak-sentinel', 'dep-sentinel', 'hazard-sentinel', 'lint-sentinel', 'final-draft-gate'])
const name = process.argv[2]
if (!SENTINELS.has(name)) {
  console.error(`omit: the Ribhu adapter has no sentinel called "${name}". It runs: ${[...SENTINELS].join(', ')}`)
  process.exit(1)
}

// A payload this cannot read is passed on as it arrived. Each sentinel already
// decides what an unreadable payload means, and that decision is not this
// file's to make differently.
const raw = readFileSync(0, 'utf8')
let payload = raw
try {
  const { input, cwd } = JSON.parse(raw)
  const { path, ...rest } = input !== null && typeof input === 'object' ? input : {}
  payload = JSON.stringify({ cwd, tool_input: path === undefined ? rest : { ...rest, file_path: path } })
} catch {}

const run = spawnSync(process.execPath, [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))], { input: payload, encoding: 'utf8' })
if (run.error) {
  console.error(`omit: could not run ${name}: ${run.error.message}`)
  process.exit(1)
}
// The sentinel's stdout stops here. Ribhu reads a hook's stdout as a rewrite of
// the tool's input or output, and nothing a sentinel prints is one.
process.stderr.write(run.stderr)
process.exit(run.status ?? 1)
