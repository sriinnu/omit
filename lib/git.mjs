// Git access shared by the CLI and the hooks.
//
// This contract exists because the previous one was fail-open. `git()` caught
// everything and returned null, and callers coalesced that to '' — so "git
// could not answer" (a diff past the buffer limit, a ref that does not exist)
// was indistinguishable from "there is nothing here". A gate reporting
// "hazards: 0" because it never read the diff is worse than one that crashes:
// the verdict looks healthy while nothing was examined.
//
// So: absence is a legitimate answer only where it is returned explicitly
// (`fileAtRevision` says `present: false`), and every other failure throws.
// Callers that cannot tolerate a throw use `probe` and must surface `ok:false`
// as a hard error of their own — never as an empty result.
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'

// Real diffs exceed Node's 1 MiB default routinely — a lockfile, a vendored
// asset, a generated bundle. The old code threw ENOBUFS past that and swallowed
// it, which turned any large commit into a clean verdict. The ceiling is high
// rather than absent so a runaway still fails loudly instead of exhausting memory.
const MAX_BUFFER = 1 << 30

export class GitError extends Error {
  constructor(args, reason) {
    super(`git ${args.join(' ')} — ${reason}`)
    this.name = 'GitError'
    this.args = args
    this.reason = reason
  }
}

// { ok: true, out } | { ok: false, reason }, never throws. stderr is captured
// because git's message is what distinguishes "this path is not in that
// revision" from "that revision does not exist".
export function probe(cwd, args, env = process.env) {
  try {
    const out = execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER })
    return { ok: true, out }
  } catch (e) {
    const reason = String(e.stderr ?? '').trim() || e.code || e.message || 'failed'
    return { ok: false, reason }
  }
}

export function git(cwd, args, env) {
  const r = probe(cwd, args, env)
  if (!r.ok) throw new GitError(args, r.reason)
  return r.out
}

// The absolute repo root, or null when cwd is not inside a repository.
// Every path handed to a `rev:path` argument must be resolved against this,
// never against the caller's cwd: git reports and resolves those root-relative.
export function repoRoot(cwd) {
  const r = probe(cwd, ['rev-parse', '--show-toplevel'])
  return r.ok ? r.out.trim() : null
}

// The same question for a hook, where the two nulls want opposite exits: no
// repository means there is no history to compare against, while a git that
// cannot run at all (missing binary, dubious ownership, unreadable object
// store) means the check never happened. git's own message is the only thing
// that separates the two, so match on it and throw on everything else.
export function repoRootStrict(cwd) {
  const r = probe(cwd, ['rev-parse', '--show-toplevel'])
  if (r.ok) return r.out.trim()
  if (/not a git repository|must be run in a work tree/i.test(String(r.reason))) return null
  throw new Error(`git could not report the repository root (${r.reason})`)
}

// A path relative to the repo ROOT, or null when the file is outside the repo.
// Resolved, so a `..` cannot smuggle something past the caller's containment
// check by being lexically inside.
export function repoRelPath(root, file) {
  const abs = resolve(root, file)
  const rel = relative(root, abs)
  if (rel !== '' && !rel.startsWith('..')) return rel
  // The harness's file_path and git's `--show-toplevel` can disagree on a
  // symlinked prefix — macOS resolves /var to /private/var, so a repo under a
  // tmpdir yields a path that reads as outside itself. Retry once through
  // realpath before concluding the file is genuinely elsewhere; without this a
  // real manifest edit is waved through as "outside the repo".
  try {
    const real = relative(realpathSync(root), realpathSync(abs))
    if (real !== '' && !real.startsWith('..')) return real
  } catch {}
  return null
}

// Content of `file` at `rev`, where `rev` is any tree-ish: 'HEAD', an empty
// string for the staged (index) blob, or a branch/tag. Three outcomes:
//
//   { present: true, text }   it exists there
//   { present: false }        it legitimately does not — a new file has no
//                             earlier revision, and neither does anything in a
//                             repo whose HEAD has no commits yet
//   { failed: true, reason }  git could not answer, which is not the same as
//                             empty and must not be rendered as one
export function fileAtRevision(cwd, rev, path) {
  if (!path) return { present: false }
  // An unborn HEAD has no revision to look in — absence, not failure. Checked
  // separately because `git show HEAD:x` reports it as an invalid object name,
  // which is otherwise indistinguishable from a genuinely broken revision.
  if (rev === 'HEAD' && !probe(cwd, ['rev-parse', '--verify', 'HEAD']).ok) return { present: false }

  // An empty `rev` means the staged blob. Spelled `:0:<path>` rather than a bare
  // `:<path>` because git parses the latter as a malformed revision and refuses
  // it — an error indistinguishable from a refusal to answer, which made the
  // gate fail in every repo that had never used omit.
  const r = probe(cwd, ['show', rev === '' ? `:0:${path}` : `${rev}:${path}`])
  if (r.ok) return { present: true, text: r.out }
  // git words this differently per revision: a tree says "does not exist in
  // 'HEAD'", the index says "does not exist (neither on disk nor in the index)".
  // Matching only the first spelling turned an absent staged file into a hard
  // failure, which refuses a commit over a file that was never there.
  if (/does not exist|exists on disk, but not in/i.test(r.reason)) return { present: false }
  return { failed: true, reason: r.reason }
}

// numstat rows. `-z` because a renamed path is otherwise printed as the brace
// composite `{old => new}/package.json` — not a path at all: `git show` and a
// filesystem read both fail on it, so both revisions of a rename commit read as
// empty and a dependency added there goes uncited. With -z the pre-image and
// post-image names arrive as separate fields:
//   ordinary  `A\tD\t<path>\0`
//   rename    `A\tD\t\0<old>\0<new>\0`
export function parseNumstat(out) {
  const fields = out.split('\0')
  const rows = []
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i]
    if (!head) continue
    const [added, deleted, path] = head.split('\t')
    if (path === '') {
      const oldPath = fields[++i] ?? ''
      const newPath = fields[++i] ?? ''
      rows.push({ path: newPath, oldPath, added, deleted })
    } else {
      rows.push({ path, oldPath: path, added, deleted })
    }
  }
  return rows
}

// The whole working tree — tracked and untracked, minus ignored — as a git tree
// object, without touching the user's index: `git add -A` runs against a copy.
// Stored as a tree hash so the Stop gate can diff this session's edits against
// it and leave pre-existing dirt out of the count.
export function snapshotTree(root) {
  const real = resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim())
  const tmp = `${real}.omit-${process.pid}-${Date.now()}`
  try {
    if (existsSync(real)) copyFileSync(real, tmp)
    const env = { ...process.env, GIT_INDEX_FILE: tmp }
    git(root, ['add', '-A', '--', '.'], env)
    return git(root, ['write-tree'], env).trim()
  } finally {
    rmSync(tmp, { force: true })
  }
}

function baselineFile(root) {
  return resolve(root, git(root, ['rev-parse', '--git-path', 'omit/baseline.json']).trim())
}

export function writeBaseline(root, session) {
  const file = baselineFile(root)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ session, tree: snapshotTree(root), at: new Date().toISOString() }) + '\n')
}

// { session, tree } or null. Anything unexpected — missing, a symlink, oversized,
// malformed, or a tree the object store no longer has — is null, and callers
// fall back to HEAD: a wrong baseline must never shrink the counted change.
export function readBaseline(root) {
  try {
    const file = baselineFile(root)
    const st = lstatSync(file)
    if (!st.isFile() || st.size > 4096) return null
    const { session, tree } = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof session !== 'string' || !/^[0-9a-f]{40,64}$/.test(tree)) return null
    if (!probe(root, ['cat-file', '-e', `${tree}^{tree}`]).ok) return null
    return { session, tree }
  } catch {
    return null
  }
}
