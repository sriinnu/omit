import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessCommand } from '../lib/danger.mjs'

const blocked = (cmd) => assert.ok(assessCommand(cmd).length > 0, `expected blocked: ${cmd}`)
const allowed = (cmd) => assert.deepEqual(assessCommand(cmd), [], `expected allowed: ${cmd}`)

test('protected-root deletes are blocked', () => {
  blocked('rm -rf /')
  blocked('rm -rf ~')
  blocked('rm -rf $HOME')
  blocked('rm -rf /etc')
  blocked('rm -rf /Users/srinivaspendela')
  blocked('sudo rm -rf /')
})

test('cwd wipe and unset-variable deletes are blocked', () => {
  blocked('rm -rf .')
  blocked('rm -rf ./')
  blocked('rm -rf *')
  blocked('rm -rf $OUT/*')
  blocked('rm -rf ${TARGET_DIR}')
})

test('disk-level destruction is blocked', () => {
  blocked('dd if=/dev/zero of=/dev/disk0')
  blocked('mkfs.ext4 /dev/sda1')
  blocked('diskpart')
})

test('fork bomb is blocked', () => {
  blocked(':(){ :|:& };:')
})

test('find -delete sweeping a protected root is blocked', () => {
  blocked('find / -name "*.tmp" -delete')
  blocked('find ~ -name "*.log" -exec rm {} \\;')
})

test('scoped, ordinary commands are allowed', () => {
  allowed('rm -rf node_modules')
  allowed('rm -rf ./dist')
  allowed('rm file.txt')
  allowed('git status')
  allowed('ls -la')
  allowed('find ./src -name "*.test.js" -delete')
})

test('omit-allow suppresses a reviewed line', () => {
  allowed('rm -rf / # omit-allow: reviewed with the user, wiping a scratch VM')
})
