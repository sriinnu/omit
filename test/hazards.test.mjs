import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findHazards, SECRET_RULES } from '../lib/hazards.mjs'

const secretRules = (lines) => findHazards(lines).filter((f) => f.type === 'secret').map((f) => f.rule)
const injectionRules = (lines) => findHazards(lines).filter((f) => f.type === 'injection').map((f) => f.rule)

// Key-shaped fixtures are assembled from fragments at runtime. Secrets have no
// override (see the no-override test below), so a literal `AKIA…`/`ghp_…`
// written into this file would — correctly — be flagged by hazard-sentinel and
// block the repo's own commits: it scans the added lines of every file, this
// one included. The suite obeys the rule it tests instead of being exempted
// from it. Every assembled value still matches its rule; only the file text
// stops containing a key-shaped string.
const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const privateKey = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
const github = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'
const slack = 'xoxb-' + '1234567890-abcdefghij'
const anthropic = 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz'
const stripe = 'sk_live_' + 'abcdefghijklmnopqrstuv'
const openai = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789'
const google = 'AIza' + 'SyA' + 'b'.repeat(32)
const chitragupta = 'chg_' + 'abcdefghijklmnopqrstuvwx'
const credential = 'api_key: "' + 'abcdefghijklmnopqrstuvwx' + '"'

test('SECRET_RULES catches known key prefixes', () => {
  assert.ok(secretRules([`const k = "${aws}"`]).includes('aws-access-key'))
  assert.ok(secretRules([privateKey]).includes('private-key-block'))
  assert.ok(secretRules([`token = "${github}"`]).includes('github-token'))
  assert.ok(secretRules([`const t = "${slack}"`]).includes('slack-token'))
  assert.ok(secretRules([`key = "${anthropic}"`]).includes('anthropic-key'))
  assert.ok(secretRules([`const k = "${stripe}"`]).includes('stripe-live-key'))
  assert.ok(secretRules([`const k = "${google}"`]).includes('google-api-key'))
  assert.ok(secretRules([`const k = "${chitragupta}"`]).includes('chitragupta-key'))
})

test('chitragupta-key does not false-positive on unrelated strings', () => {
  assert.deepEqual(secretRules(['const msg = "not a secret at all"']), [])
  assert.deepEqual(secretRules(['const chg = "short"']), [])
})

test('hardcoded-credential catches quoted literal assignments, not variable refs', () => {
  assert.ok(secretRules([credential]).includes('hardcoded-credential'))
  assert.deepEqual(secretRules(['api_key: $API_KEY']), [])
  assert.deepEqual(secretRules(['const apiKey = process.env.API_KEY']), [])
})

test('injection patterns are caught', () => {
  assert.ok(injectionRules(['eval(userInput)']).includes('eval')) // omit-allow: test fixture, not real code
  assert.ok(injectionRules(['dangerouslySetInnerHTML={{__html: x}}']).includes('inner-html')) // omit-allow: test fixture, not real code
  assert.ok(injectionRules(['pickle.loads(data)']).includes('pickle-load')) // omit-allow: test fixture, not real code
  assert.ok(injectionRules(['yaml.load(raw)']).includes('yaml-unsafe-load')) // omit-allow: test fixture, not real code
  assert.deepEqual(injectionRules(['yaml.load(raw, Loader=yaml.SafeLoader)']), [])
})

test('sql-string-built fires only when built from untrusted interpolation', () => {
  assert.ok(
    findHazards(['db.execute(`SELECT * FROM users WHERE id = ${id}`)']).some((f) => f.rule === 'sql-string-built'), // omit-allow: test fixture, not real code
  )
  assert.deepEqual(
    findHazards(['db.execute("SELECT * FROM users WHERE id = ?", [id])']).filter((f) => f.rule === 'sql-string-built'),
    [],
  )
})

// A secret is not a style call, so there is nothing here for a reviewer to
// approve: the marker has to stay powerless over SECRET_RULES for the README's
// "Secrets have no override" to be a description of the code.
test('a secret is never suppressible, marker or not', () => {
  const lines = [
    `const k = "${aws}" // omit-allow:`,
    `const k = "${aws}" // omit-allow: reviewed with the user, it is a fixture`,
    `const k = "${aws}" # omit-allow: reviewed with the user, it is a fixture`,
    `const k = "${aws}" // the reviewer was sure`,
  ]
  for (const line of lines) {
    assert.ok(secretRules([line]).includes('aws-access-key'), `omit-allow: silenced a secret: ${line}`)
  }
})

test('injection findings are suppressed only by a trailing comment carrying a reason', () => {
  assert.deepEqual(findHazards(['eval(userInput) // omit-allow: reviewed with the user, input is a fixed map']), []) // omit-allow: test fixture, not real code
  // a bare token, a token in a string literal, and a token in ordinary text are
  // not reviews — the docs have always said `omit-allow: <reason>`
  assert.ok(injectionRules(['eval(userInput) // omit-allow:']).includes('eval')) // omit-allow: test fixture, not real code
  assert.ok(injectionRules(['eval(userInput) // omit-allow:   ']).includes('eval')) // omit-allow: test fixture, not real code
  assert.ok(injectionRules(['eval(userInput); const note = "// omit-allow: not a comment"']).includes('eval')) // omit-allow: test fixture, not real code
  assert.ok(injectionRules(['eval(userInput) && echo omit-allow: x']).includes('eval')) // omit-allow: test fixture, not real code
})

test('every SECRET_RULES entry actually matches a real sample of its own shape', () => {
  // Each rule's regex is tested against a sample of the value it's supposed
  // to catch — a typo'd regex that never matches anything real would fail
  // here (unlike `re instanceof RegExp`, which is true for any regex literal
  // regardless of whether it matches its own intended shape).
  const samples = {
    'aws-access-key': aws,
    'private-key-block': privateKey,
    'github-token': github,
    'slack-token': slack,
    'anthropic-key': anthropic,
    'stripe-live-key': stripe,
    'openai-style-key': openai,
    'google-api-key': google,
    'chitragupta-key': chitragupta,
    'hardcoded-credential': credential,
  }
  assert.deepEqual(
    Object.keys(samples).sort(),
    SECRET_RULES.map(([rule]) => rule).sort(),
    'a rule was added to SECRET_RULES without a sample here (or vice versa) — this test would otherwise silently stop covering it',
  )
  for (const [rule, re] of SECRET_RULES) {
    assert.ok(re.test(samples[rule]), `${rule} does not match its own intended sample: ${samples[rule]}`)
  }
})
