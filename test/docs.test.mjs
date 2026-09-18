// The rule files are what an agent actually reads, so their examples are claims
// like any other: an example that does not verify teaches the wrong shape, and
// an agent that follows it verbatim gets blocked by the tool that printed it.
// This pins the documentation to the checker — change the schema and these fail
// before a user does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReceipt } from '../lib/receipts.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

// Every rule file an agent might be handed, plus the two that carry full examples.
const RULE_FILES = [
  'skills/omit/SKILL.md',
  'AGENTS.md',
  '.cursor/rules/omit.mdc',
  '.clinerules/omit.md',
  '.windsurf/rules/omit.md',
  '.github/copilot-instructions.md',
]

const read = (rel) => readFileSync(join(REPO, rel), 'utf8')

// A receipt example appears either bare (a fenced block) or wrapped in backticks
// inside a table cell.
function examplesIn(text) {
  const out = []
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/`(\{"claim".*?\})`/g)) out.push(m[1])
    const bare = line.trim().match(/^(\{"claim".*\})$/)
    if (bare) out.push(bare[1])
  }
  return [...new Set(out)]
}

const KNOWN_CLAIMS = new Set(['reuse', 'stdlib', 'installed-dep', 'new-dep'])

test('every receipt example in every rule file is well-formed', () => {
  let seen = 0
  for (const rel of RULE_FILES) {
    for (const raw of examplesIn(read(rel))) {
      let parsed
      assert.doesNotThrow(() => {
        parsed = JSON.parse(raw)
      }, `${rel}: example is not valid JSON: ${raw}`)
      assert.ok(KNOWN_CLAIMS.has(parsed.claim), `${rel}: example names an unknown claim "${parsed.claim}": ${raw}`)
      seen++
    }
  }
  // A guard against this test quietly passing because the extractor stopped
  // matching — the files have examples today.
  assert.ok(seen >= 8, `only ${seen} examples found across ${RULE_FILES.length} rule files; the extractor has drifted`)
})

// The examples are not decorative: the table in SKILL.md tells an agent exactly
// what to write, so each one has to survive the check it advertises.
test('every receipt example in SKILL.md actually verifies', () => {
  const examples = examplesIn(read('skills/omit/SKILL.md'))
  assert.ok(examples.length >= 4, `expected the four documented shapes, found ${examples.length}`)

  // A fixture built to satisfy exactly what the docs promise: the cited file and
  // line exist, zod is declared and installed, and `padTo` is nowhere.
  const dir = mkdtempSync(join(tmpdir(), 'omit-docs-'))
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'ignore'] })
  git(['init', '-q', '.'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  const filler = Array.from({ length: 41 }, (_, i) => `// line ${i + 1}`).join('\n')
  writeFileSync(join(dir, 'src', 'x.ts'), `${filler}\nexport function parseRange(spec) {\n  return spec.split('-')\n}\n`)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { zod: '^3.22.0' } }))
  mkdirSync(join(dir, 'node_modules', 'zod'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'zod', 'index.js'), 'module.exports = { object: 1 }\n')
  git(['add', '-A'])
  git(['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'])

  for (const raw of examples) {
    const r = JSON.parse(raw)
    const result = verifyReceipt(r, dir)
    assert.equal(
      result.status,
      'verified',
      `SKILL.md documents a shape that does not verify: ${raw}\n  ${result.checks.map((c) => `[${c.kind}] ${c.detail}`).join('\n  ')}`
    )
  }
})

// The mirrors are compact, but they carry the same schema. If they drift from
// SKILL.md, an agent on Cursor is taught a shape that a Claude agent is not.
test('the compact rule files carry the same receipt fields as SKILL.md', () => {
  const full = read('skills/omit/SKILL.md')
  for (const rel of RULE_FILES.filter((f) => f !== 'skills/omit/SKILL.md')) {
    const text = read(rel)
    for (const field of ['claim', 'rung', 'file', 'line', 'symbol', 'api', 'run', 'dep', 'absent']) {
      if (!full.includes(`"${field}"`)) continue
      assert.ok(text.includes(`"${field}"`), `${rel} is missing the "${field}" field that SKILL.md documents`)
    }
  }
})

// A rule file is read by the agent, so a stale instruction is a bug that shows up
// as a blocked session. These are the claims most likely to rot.
test('the rule files do not promise mechanisms the code removed', () => {
  for (const rel of RULE_FILES) {
    const text = read(rel)
    assert.doesNotMatch(text, /omit score|score\/100/, `${rel} still advertises the removed score`)
    assert.doesNotMatch(text, /"receipt"\s*:/, `${rel} still shows the pre-0.4.0 prose receipt shape`)
    assert.doesNotMatch(text, /"tried"\s*:\s*\[\s*\{\s*"rung"\s*:\s*\d+\s*,\s*"file"/, `${rel} still shows a tried entry citing a location`)
  }
})

// The Final Draft is parsed by the stop gate, so the skill has to ask for a
// shape the gate can read. Prose is not parseable, and an honest report that
// cannot be read is an honest report that gets refused.
test('the Final Draft instructions name a format the gate parses', () => {
  const text = read('skills/omit/SKILL.md')
  for (const [what, re] of [
    ['a file count', /files touched/i],
    ['an added/removed pair', /lines\s*\+|\+\d+\s*[−-]/i],
    ['a dependency count', /new dependencies/i],
  ]) {
    assert.match(text, re, `SKILL.md asks for a report without ${what}, which the stop gate cannot parse`)
  }
})
