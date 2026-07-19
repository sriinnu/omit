import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findHazards, SECRET_RULES } from '../lib/hazards.mjs'

const secretRules = (lines) => findHazards(lines).filter((f) => f.type === 'secret').map((f) => f.rule)
const injectionRules = (lines) => findHazards(lines).filter((f) => f.type === 'injection').map((f) => f.rule)

test('SECRET_RULES catches known key prefixes', () => {
  assert.ok(secretRules(['const k = "AKIAABCDEFGHIJKLMNOP"']).includes('aws-access-key')) // omit-allow: test fixture, not real
  assert.ok(secretRules(['-----BEGIN RSA PRIVATE KEY-----']).includes('private-key-block')) // omit-allow: test fixture, not real
  assert.ok(secretRules(['token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"']).includes('github-token')) // omit-allow: test fixture, not real
  assert.ok(secretRules(['const t = "xoxb-1234567890-abcdefghij"']).includes('slack-token')) // omit-allow: test fixture, not real
  assert.ok(secretRules(['key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"']).includes('anthropic-key')) // omit-allow: test fixture, not real
  assert.ok(secretRules(['const k = "sk_live_abcdefghijklmnopqrstuv"']).includes('stripe-live-key')) // omit-allow: test fixture, not real
  assert.ok(secretRules(['const k = "AIzaSyAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"']).includes('google-api-key')) // omit-allow: test fixture, not real
  assert.ok(secretRules(['const k = "chg_abcdefghijklmnopqrstuvwx"']).includes('chitragupta-key')) // omit-allow: test fixture, not real
})

test('chitragupta-key does not false-positive on unrelated strings', () => {
  assert.deepEqual(secretRules(['const msg = "not a secret at all"']), [])
  assert.deepEqual(secretRules(['const chg = "short"']), [])
})

test('hardcoded-credential catches quoted literal assignments, not variable refs', () => {
  assert.ok(secretRules(['api_key: "abcdefghijklmnopqrstuvwx"']).includes('hardcoded-credential')) // omit-allow: test fixture, not real
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

test('omit-allow suppresses a reviewed line', () => {
  assert.deepEqual(findHazards(['const k = "AKIAABCDEFGHIJKLMNOP" // omit-allow: test fixture, not real']), [])
})

test('every SECRET_RULES entry actually matches a real sample of its own shape', () => {
  // Each rule's regex is tested against a sample of the value it's supposed
  // to catch — a typo'd regex that never matches anything real would fail
  // here (unlike `re instanceof RegExp`, which is true for any regex literal
  // regardless of whether it matches its own intended shape).
  // Each value is a test fixture, not a real credential — omit-allow: is
  // repeated per line since hazard-sentinel checks line by line, not per block.
  const samples = {
    'aws-access-key': 'AKIAABCDEFGHIJKLMNOP', // omit-allow: test fixture, not real
    'private-key-block': '-----BEGIN RSA PRIVATE KEY-----', // omit-allow: test fixture, not real
    'github-token': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', // omit-allow: test fixture, not real
    'slack-token': 'xoxb-1234567890-abcdefghij', // omit-allow: test fixture, not real
    'anthropic-key': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', // omit-allow: test fixture, not real
    'stripe-live-key': 'sk_live_abcdefghijklmnopqrstuv', // omit-allow: test fixture, not real
    'openai-style-key': 'sk-abcdefghijklmnopqrstuvwxyz0123456789', // omit-allow: test fixture, not real
    'google-api-key': 'AIzaSyAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', // omit-allow: test fixture, not real
    'chitragupta-key': 'chg_abcdefghijklmnopqrstuvwx', // omit-allow: test fixture, not real
    'hardcoded-credential': 'api_key: "abcdefghijklmnopqrstuvwx"', // omit-allow: test fixture, not real
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
