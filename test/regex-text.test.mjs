// A regex-like fragment in the assessed command is text, never a pattern. The glob
// checks built a RegExp from `[`-bearing tokens and threw, which the hooks turned
// into a block of an innocent grep or sed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessLeak } from '../lib/leaks.mjs'

const COMMANDS = ["grep -E '^\\[|x' file.txt", "sed 's/\\x1b\\[[0-9;]*m//g' out.log"]
const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url))

test('assessLeak assesses regex-like command text instead of throwing', () => {
  for (const cmd of COMMANDS) {
    assert.doesNotThrow(() => assessLeak(cmd), cmd)
    assert.deepEqual(assessLeak(cmd), [], cmd)
  }
})

test('leak and tamper sentinels pass regex-like command text', () => {
  for (const command of COMMANDS) {
    for (const name of ['leak-sentinel.mjs', 'tamper-sentinel.mjs']) {
      const r = spawnSync('node', [join(HOOKS, name)], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() }) })
      assert.equal(r.status, 0, `${name} on ${command}: ${r.stderr}`)
    }
  }
})
