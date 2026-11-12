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

test('find -delete is judged on its roots, not on any absolute path', () => {
  blocked('find /etc -delete')
  blocked('find / -execdir rm {} \\;')
  blocked('find . -execdir rm {} \\;')
  blocked('find /tmp /etc -name x -delete')
  blocked('find -L / -delete')
  blocked('find $OUT -delete')
  blocked('find $HOME/* -delete')
  // /tmp/scratch and a project under /Users are not protected roots; the old
  // rule matched any absolute path and refused ordinary cleanup.
  allowed('find /tmp/build -name "*.o" -delete')
  allowed('find /Users/sriinnu/project -name "*.tmp" -delete')
  allowed('find "$HOME/.cache/app" -name "*.log" -delete')
  allowed('find ${OUT:?} -delete')
})

test('scoped, ordinary commands are allowed', () => {
  allowed('rm -rf node_modules')
  allowed('rm -rf ./dist')
  allowed('rm file.txt')
  allowed('git status')
  allowed('ls -la')
  allowed('find ./src -name "*.test.js" -delete')
})

test('system and credential roots are protected for rm and find alike', () => {
  for (const t of ['/System', '/Library', '/Applications', '/private', '/Volumes', '/Users', '/System/Library', '/usr/local', '/etc/ssh', '/private/var', '/var/lib', '~/.ssh', '$HOME/.gnupg', '..', '../..']) {
    blocked(`rm -rf ${t}`)
    blocked(`find ${t} -delete`)
  }
  allowed('rm -rf /Applications/Old.app')
  allowed('rm -rf /opt/myapp')
  allowed('rm -rf ~/.cache/app')
  allowed('rm -rf ../build')
  allowed('find ~/Documents/scratch -name "*.tmp" -delete')
})

test('a variable is judged on its default, an empty one is unset', () => {
  blocked('rm -rf ${X:-/}')
  blocked('rm -rf ${X-}/')
  blocked('find ${X:-/} -name x -delete')
  blocked('find ${X:-} -name x -delete')
  allowed('rm -rf ${X:-/tmp/build}')
  allowed('find ${X:-/tmp/build} -name x -delete')
})

test('find skips its whole option cluster before reading roots', () => {
  for (const o of ['-E', '-x', '-s', '-HL', '-d', '-f', '--', '-O2']) blocked(`find ${o} / -name x -delete`)
  allowed('find -x /tmp/build -name x -delete')
})

test('a quoted variable root is not the working directory when empty', () => {
  allowed('find "$BUILD" -name "*.o" -delete')
  blocked('find $BUILD -name "*.o" -delete')
})

test('omit-allow suppresses a reviewed command only as a trailing comment, with a reason', () => {
  allowed('rm -rf / # omit-allow: reviewed with the user, wiping a scratch VM')
  // a bare token, a reasonless marker, a token in a string literal and a marker
  // that isn't the trailing comment are all free text, not a review
  blocked('rm -rf ~; echo omit-allow: x')
  blocked('rm -rf ~; echo "omit-allow:"')
  blocked('rm -rf ~; echo "# omit-allow: nope"')
  blocked('rm -rf ~ # omit-allow:')
  blocked('rm -rf ~ # omit-allow:   ')
  blocked('rm -rf ~ && echo omit-allow: # looked reviewed to the regex')
  blocked('rm -rf ~ # omit-allow: reviewed, then more command\nls')
})

test('agents cannot unset hooksPath or flip omit trust keys', () => {
  blocked('git config --global --unset core.hooksPath')
  blocked('git config --local omit.trusted true')
  blocked('git config omit.enforce false')
  allowed('git config --local --bool omit.trusted 2>/dev/null')
  allowed('git config omit.enforce true')
  allowed('git config --get core.hooksPath')
})
