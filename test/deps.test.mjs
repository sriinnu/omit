import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isManifest, addedDeps } from '../lib/deps.mjs'

test('isManifest recognizes known manifest filenames', () => {
  assert.ok(isManifest('package.json'))
  assert.ok(isManifest('path/to/requirements.txt'))
  assert.ok(isManifest('Cargo.toml'))
  assert.ok(!isManifest('README.md'))
  assert.ok(!isManifest('package-lock.json'))
})

test('addedDeps finds a genuinely new package.json dependency', () => {
  const diff = [
    ' "dependencies": {',
    '-  "left-pad": "^1.0.0"',
    '+  "left-pad": "^1.0.0",',
    '+  "lodash": "^4.17.21"',
    ' }',
  ].join('\n')
  assert.deepEqual(addedDeps('package.json', diff), ['lodash'])
})

test('addedDeps ignores a reformatted line (version bump, trailing comma) as not new', () => {
  const diff = ['-  "lodash": "^4.17.20"', '+  "lodash": "^4.17.21"'].join('\n')
  assert.deepEqual(addedDeps('package.json', diff), [])
})

test('addedDeps works for requirements.txt', () => {
  const diff = ['+requests==2.31.0', '+numpy>=1.24'].join('\n')
  assert.deepEqual(addedDeps('requirements.txt', diff), ['requests', 'numpy'])
})
