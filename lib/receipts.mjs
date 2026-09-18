// Receipts: the agent's claims, made checkable by something other than the agent.
//
// A citation only its author can read is a self-report. Every receipt here names
// the thing it claims and the evidence for it in a form this module checks
// itself — a path/line/symbol it opens, a symbol it searches the repo for, or a
// snippet it runs. A receipt that fails its check is not a receipt; it is the
// fabrication the ledger exists to catch.
//
// Accepted shapes, one per JSON line in .omit/receipts.jsonl:
//
//   {"claim":"reuse","rung":2,"file":"src/util.ts","line":42,"symbol":"parseRange"}
//   {"claim":"stdlib","rung":3,"api":"crypto.randomUUID","run":["node","-e","crypto.randomUUID()"]}
//   {"claim":"installed-dep","rung":5,"dep":"zod","run":["node","-e","require('zod').object"]}
//   {"claim":"new-dep","rung":7,"dep":"left-pad","tried":[{"rung":2,"absent":"padTo"}]}
//
// EVIDENCE IS BOUND TO THE CLAIM. That is the whole design, and it is why the
// shapes look fussy. A snippet's exit status alone proves nothing — `["true"]`
// exits 0 and `["false"]` exits 1 while testing neither the standard library nor
// any dependency — so `run` must also name what it exercises (`api` or `dep`)
// AND the argv text must mention it. Without that binding, the cheapest way to
// satisfy a check that demands failure is to write a citation that cannot be
// true, and the mechanism ends up rewarding fabricated failure.
//
// `new-dep` is the strongest claim here: it asserts the earlier omissions were
// TRIED and did not hold. So a `tried` entry cites an absence to be reconstructed
// (a symbol to search the repo for) rather than a path to be taken on trust —
// the verifier does the searching, not the author.
//
// Trust model: `.omit/receipts.jsonl` is executable in the same sense a Makefile
// is — `run` is spawned. argv arrays, never a shell, so nothing expands; a
// SIGKILL timeout and a total budget cap it. Reading a checkout you don't trust?
// OMIT_NO_EXEC=1 downgrades every `run` check to "unverifiable" instead of
// executing it.
//
// omitted: requiring a `reuse` citation to exist at HEAD: a working-tree read is
// what a staged-file workflow needs, and citing a file written moments ago makes
// a `tried` entry HOLD (refuting the receipt), which is the safe direction. Add
// the revision check if a receipt ever cites new code as if it were pre-existing.
// omitted: a filesystem sandbox: out of scope for a zero-dependency CLI, and the
// honest boundary is the opt-in, not a pretence of confinement.
// omitted: proving a snippet SEMANTICALLY exercises its subject. The binding is
// textual — the argv must name what it claims to test — which closes snippets
// that exit on demand (`["true"]`, `["false"]`) but not one that names a symbol
// without calling it. Real proof would mean the verifier writes the snippet, and
// then it is testing the verifier, not the claim.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, join, relative, resolve } from 'node:path'
import { isManifest, parseDeps, MANIFESTS } from './deps.mjs'
import { execDisabled } from './exec.mjs'
import { probe, repoRoot } from './git.mjs'

export const LEDGER = join('.omit', 'receipts.jsonl')

const SYMBOL_WINDOW = 5
const RUN_TIMEOUT_MS = 10_000
// Bounds, because cost is otherwise linear in ledger length and the ledger is a
// committed file: every line can spawn a process, and nothing else caps the count.
const MAX_LEDGER_LINES = 500
const MAX_RUNS = 100
const MAX_FILE_BYTES = 4 << 20
// `.omit` is skipped because the ledger is a claim ABOUT the code, not code:
// it necessarily contains every symbol it claims is absent, so searching it
// found the receipt that named the symbol and every `new-dep` receipt refuted
// itself in any repo that tracks its ledger.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.omit'])

// Re-exported so existing importers keep working; the rule itself lives in one
// place (lib/exec.mjs), because copies of it drifted once already.
export { execDisabled }

// ---------- ledger ----------
// A ledger is untrusted input like any other: `lstat` (not `stat`, which follows
// links), regular files only, a size cap, and the real path contained in the
// repo. A committed symlink to /dev/zero previously hung every caller — gate,
// hooks and CI — because `existsSync` follows links and the read never EOFs.
function safeRead(path, { root = null, cap = MAX_FILE_BYTES } = {}) {
  try {
    const st = lstatSync(path)
    if (!st.isFile() && !st.isSymbolicLink()) return { failed: `not a regular file` }
    const real = realpathSync(path)
    if (root && relative(root, real).startsWith('..')) return { failed: `resolves outside the repo` }
    const target = statSync(real)
    if (!target.isFile()) return { failed: `resolves to a ${target.isFIFO() ? 'pipe' : 'non-file'}` }
    if (target.size > cap) return { failed: `${target.size} bytes exceeds the ${cap}-byte cap` }
    return { text: readFileSync(real, 'utf8') }
  } catch (e) {
    return { failed: e.code ?? e.message ?? 'unreadable' }
  }
}

// Malformed lines are reported, never thrown: one bad line must not hide the
// receipts around it.
export function readLedger(cwd) {
  const path = join(cwd, LEDGER)
  const read = safeRead(path)
  if (read.failed) return { entries: [], error: `${LEDGER} ${read.failed}` }

  const out = []
  const lines = read.text.split('\n').filter((l) => l.trim())
  if (lines.length > MAX_LEDGER_LINES) out.push({ at: 0, receipt: null, error: `ledger has ${lines.length} lines, over the ${MAX_LEDGER_LINES} cap — the rest were not checked` })
  lines.slice(0, MAX_LEDGER_LINES).forEach((line, i) => {
    try {
      out.push({ at: i + 1, receipt: JSON.parse(line) })
    } catch (e) {
      out.push({ at: i + 1, receipt: null, error: e.message })
    }
  })
  return { entries: out }
}

// ---------- checks ----------
// Each check reports ok:true (holds), ok:false (ran, and refutes the claim), or
// ok:null (could not be determined — never silently counted as agreement).
const ok = (kind, detail) => ({ kind, ok: true, detail })
const no = (kind, detail) => ({ kind, ok: false, detail })
const unknown = (kind, detail) => ({ kind, ok: null, detail })

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const unique = (xs) => [...new Set(xs)]

// "This code already exists" — the file, the line, and the symbol must all be
// there. A cited line that drifted is a stale citation, and it fails rather
// than quietly passing.
function checkReuse(r, cwd) {
  const { file, line, symbol } = r
  if (typeof file !== 'string' || !file) return [unknown('reuse', 'no `file`')]
  if (typeof symbol !== 'string' || !symbol) return [unknown('reuse', 'no `symbol`')]
  if (!Number.isInteger(line) || line < 1) return [unknown('reuse', 'no 1-based integer `line`')]

  const root = repoRoot(cwd) ?? cwd
  const abs = resolve(root, file)
  const read = safeRead(abs, { root })
  if (read.failed) return [no('reuse', `${file}: ${read.failed}`)]

  const lines = read.text.split('\n')
  if (line > lines.length) return [no('reuse', `${file} has ${lines.length} lines, not ${line}`)]
  const from = Math.max(0, line - 1 - SYMBOL_WINDOW)
  const to = Math.min(lines.length, line + SYMBOL_WINDOW)
  // A symbol is matched as a literal, not as a pattern: `\b` assertions would
  // make a call form like `parseRange()` unfalsifiable, which tells an honest
  // agent its accurate citation is a fabrication.
  const found = lines.slice(from, to).findIndex((l) => l.includes(symbol))
  return found === -1
    ? [no('reuse', `${symbol} is not within ${SYMBOL_WINDOW} lines of ${file}:${line}`)]
    : [ok('reuse', `${file}:${from + found + 1} contains ${symbol}`)]
}

// "Nothing in the codebase does this" — an ABSENCE, reconstructed here by
// searching rather than accepted from the author. This is what makes a `tried`
// entry meaningful: citing a path that simply does not exist proves nothing, but
// a repo-wide search that comes back empty is evidence.
//
// Note the polarity: this check reports whether the SYMBOL IS ABSENT, which is
// what the author wrote. Every other check reports whether the OMISSION HOLDS.
// `checkNewDep` inverts this one accordingly — a true absence is the omission
// failing, not holding.
function checkAbsent(r, cwd) {
  if (typeof r.absent !== 'string' || !r.absent) return [unknown('absent', 'no `absent` symbol to search for')]
  const hits = searchRepo(cwd, r.absent)
  if (hits === null) return [unknown('absent', 'could not search the tree')]
  return hits.length === 0
    ? [ok('absent', `no occurrence of ${r.absent} anywhere in the tree`)]
    : [no('absent', `${r.absent} is present at ${hits.slice(0, 3).join(', ')}`)]
}

// "An already-installed dependency handles it" — declared by one of the repo's
// own manifests, and the snippet must name it and execute.
function checkInstalledDep(r, cwd) {
  const checks = []
  if (typeof r.dep !== 'string' || !r.dep) checks.push(unknown('installed-dep', 'no `dep`'))
  else {
    const declared = declaredDeps(cwd)
    checks.push(declared.has(r.dep) ? ok('installed-dep', `${r.dep} is declared`) : no('installed-dep', `${r.dep} is not declared by any manifest`))
  }
  return [...checks, ...checkRun(r, cwd, r.dep)]
}

// A `run` snippet must name the API or dependency it exercises, and its argv text
// must mention it. Exit status alone is not evidence: `["true"]` proves nothing.
function checkRun(r, cwd, dep) {
  const subject = typeof r.api === 'string' && r.api ? r.api : dep
  if (!subject) return [unknown('run', 'the receipt names no `api` or `dep`, so nothing binds this snippet to a claim')]
  if (r.run === undefined) return [unknown('run', 'no `run` snippet — a snippet that executes is the evidence here')]
  if (!Array.isArray(r.run) || r.run.length === 0 || r.run.some((a) => typeof a !== 'string' || !a)) {
    return [unknown('run', '`run` must be a non-empty array of strings')]
  }
  if (!r.run.join(' ').includes(subject)) {
    return [unknown('run', `the snippet does not mention ${subject}, so it does not exercise the thing claimed`)]
  }
  if (execDisabled()) return [unknown('run', 'execution disabled by OMIT_NO_EXEC')]

  const [cmd, ...args] = r.run
  // SIGKILL, because SIGTERM is catchable and a child that ignores it holds the
  // caller — and therefore `git commit` — open forever.
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] })
  if (res.error) return [no('run', `${cmd} could not run: ${res.error.code ?? res.error.message}`)]
  if (res.status !== 0) return [no('run', `${r.run.join(' ')} exited ${res.status}`)]
  return [ok('run', `${r.run.join(' ')} runs`)]
}

// "Every earlier omission was tried and did not hold" — so every `tried` entry
// must itself fail its check. That is the whole claim, and it is checkable.
function checkNewDep(r, cwd) {
  const checks = []
  if (typeof r.dep !== 'string' || !r.dep) checks.push(unknown('new-dep', 'no `dep`'))
  if (!Array.isArray(r.tried) || r.tried.length === 0) {
    checks.push(unknown('new-dep', 'no `tried` entries — the earlier omissions are the claim, so they are the evidence'))
    return checks
  }
  r.tried.forEach((t, i) => {
    const inferred = inferClaim(t)
    const label = `tried[${i}] (rung ${t?.rung ?? '?'})`
    // A location is not evidence of absence. Citing a file that happens not to
    // exist used to produce ok:false, which read as "the omission failed" —
    // making a bad citation the cheapest possible proof that reuse was tried.
    // Absence has to be searched for, by this module, via `absent`.
    if (inferred === 'reuse') {
      checks.push(unknown('new-dep', `${label} cites a location, which cannot show that an omission was tried — write {"rung":2,"absent":"<symbol searched for>"} instead`))
      return
    }
    const inner = checksFor({ ...t, claim: inferred }, cwd)
    const detail = inner.map((c) => c.detail).join('; ')
    // An entry only counts as refuted when every part of it was actually
    // determined — a half-checked attempt could not be ruled out, and calling
    // that "it holds" would refute the receipt on no evidence.
    if (inner.length === 0 || inner.some((c) => c.ok === null)) {
      checks.push(unknown('new-dep', `${label} could not be checked: ${detail}`))
      return
    }
    // `absent` answers "is it absent?", the others answer "does it work?" — and
    // an absence is the omission failing, so its polarity is inverted here.
    const omissionHolds = inferred === 'absent' ? inner.every((c) => c.ok === false) : inner.every((c) => c.ok === true)
    checks.push(
      omissionHolds
        ? no('new-dep', `${label} actually HOLDS: ${detail} — so the omission applies and this dep is not needed`)
        : ok('new-dep', `${label} genuinely does not hold`)
    )
  })
  return checks
}

// A `tried` entry rarely repeats its own `claim` — the rung is implied by what
// evidence the entry carries. `dep` is tested before `run` on purpose: an entry
// carrying both is an installed-dep attempt, and reading it as a stdlib one
// would skip the manifest check entirely. Anything left is a location citation,
// which `checkNewDep` refuses as evidence of absence.
const inferClaim = (t) =>
  typeof t?.claim === 'string' ? t.claim
  : typeof t?.absent === 'string' ? 'absent'
  : typeof t?.dep === 'string' ? 'installed-dep'
  : Array.isArray(t?.run) ? 'stdlib'
  : 'reuse'

// Dispatch by Map, not by indexing an object literal: an untrusted `claim` of
// "constructor" or "__proto__" used to resolve to an Object.prototype member and
// crash the whole run, hiding every other receipt's verdict.
const CHECKS = new Map([
  ['reuse', checkReuse],
  ['absent', checkAbsent],
  ['stdlib', (r, cwd) => checkRun(r, cwd, null)],
  ['installed-dep', checkInstalledDep],
  ['new-dep', checkNewDep],
])

// A check that throws must not take the verdict with it, and must never read as
// agreement. `tried` entries citing a directory used to throw EISDIR out of the
// hook, which exits 1 — a non-blocking error, i.e. fail-open.
function checksFor(r, cwd) {
  const claim = typeof r?.claim === 'string' ? r.claim : null
  const check = claim !== null ? CHECKS.get(claim) : undefined
  if (!check) return [unknown('claim', `unknown claim "${claim}" — expected one of ${[...CHECKS.keys()].join(', ')}`)]
  try {
    return check(r, cwd)
  } catch (e) {
    return [unknown(claim, `the check threw: ${e.message ?? e}`)]
  }
}

// A receipt verifies only when every check it declares holds. A refuted check
// outranks an undetermined one: "I could not tell" must not mask "this is
// wrong", or disabling execution quietly downgrades every refutation to a
// warning — which is exactly what the Action's default would otherwise do.
export function verifyReceipt(receipt, cwd) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { claim: null, status: 'unverifiable', checks: [unknown('shape', 'not a JSON object')] }
  }
  const checks = checksFor(receipt, cwd)
  const status = checks.some((c) => c.ok === false) ? 'failed' : checks.some((c) => c.ok === null) || checks.length === 0 ? 'unverifiable' : 'verified'
  return { claim: receipt.claim ?? null, status, checks }
}

export function verifyLedger(cwd) {
  let runs = 0
  return readLedger(cwd).entries.map(({ at, receipt, error }) => {
    const base = error
      ? { at, claim: null, status: 'unverifiable', checks: [unknown('json', `line ${at} is not valid JSON: ${error}`)] }
      : { at, ...verifyReceipt(receipt, cwd) }
    // Bound the total work: the per-run timeout caps one snippet, not the ledger.
    if (runs++ >= MAX_RUNS) return { at, claim: base.claim, status: 'unverifiable', checks: [unknown('budget', `over the ${MAX_RUNS}-snippet cap; not checked`)] }
    return base
  })
}

// dep → the new-dep receipt that cites it, for the gate to consult.
export function newDepCitations(cwd) {
  const out = new Map()
  for (const { receipt, error } of readLedger(cwd).entries) {
    if (error || receipt?.claim !== 'new-dep' || typeof receipt.dep !== 'string') continue
    out.set(receipt.dep, verifyReceipt(receipt, cwd))
  }
  return out
}

// ---------- repo search ----------
// The absence evidence a `tried` entry is built on. Text search, bounded, and it
// refuses to answer rather than returning a partial result it cannot vouch for.
function searchRepo(cwd, symbol, { maxFiles = 2000, maxHits = 20 } = {}) {
  // Untracked files count. A working tree mid-session is mostly untracked, and
  // the file that answers "does this already exist" is usually one nobody has
  // added yet — searching only the index would miss it and report the absence
  // as confirmed. An untracked file can only ever make a receipt FAIL, which is
  // the safe direction.
  const listed = probe(cwd, ['ls-files', '-z'])
  const untracked = probe(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])
  if (!listed.ok) return null
  const hits = []
  let seen = 0
  for (const rel of `${listed.out}\0${untracked.ok ? untracked.out : ''}`.split('\0')) {
    if (!rel || rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue
    if (++seen > maxFiles) break
    const read = safeRead(join(cwd, rel), { cap: MAX_FILE_BYTES })
    if (read.failed || !read.text.includes(symbol)) continue
    hits.push(rel)
    if (hits.length >= maxHits) break
  }
  return hits
}

// Every dependency declared anywhere in the repo's own manifests. Memoized per
// process: without it, N installed-dep receipts spawn N × git ls-files.
const declaredCache = new Map()
export function declaredDeps(cwd) {
  if (declaredCache.has(cwd)) return declaredCache.get(cwd)
  const names = new Set()
  const files = new Set([...MANIFESTS].filter((n) => safeRead(join(cwd, n)).text !== undefined))
  const listed = probe(cwd, ['ls-files', '-z'])
  if (listed.ok) for (const f of listed.out.split('\0')) if (f && isManifest(f)) files.add(f)
  for (const f of files) {
    const read = safeRead(join(cwd, f))
    if (read.text === undefined) continue
    for (const d of parseDeps(basename(f), read.text)) names.add(d)
  }
  declaredCache.set(cwd, names)
  return names
}
