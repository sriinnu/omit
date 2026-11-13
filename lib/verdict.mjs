// The one definition of "does this change fail the gate", and the verdict object
// CI recomputes where the agent cannot write. `omit gate`, `omit gate --range` and
// `omit audit --fail-on gate` all decide here, so they cannot drift apart.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEDGER } from './receipts.mjs'

// Every file whose contents decide a verdict: the patterns, the parsers, the git
// plumbing the diff is read through, the receipt and lint checks, the mode rules
// and this file. Named one by one: a glob would let an unrelated file change the
// hash, and a new rule file added to the verdict path has to be listed to count.
export const RULE_FILES = ['deps', 'exec', 'git', 'hazards', 'lint', 'mode', 'receipts', 'verdict'].map((n) => `${n}.mjs`)

// Line endings are normalized so a CRLF checkout hashes like an LF one.
export function rulesHash() {
  const h = createHash('sha256')
  for (const f of RULE_FILES) h.update(`${f}\0${readFileSync(join(fileURLToPath(import.meta.url), '..', f), 'utf8').replace(/\r\n/g, '\n')}\0`)
  return h.digest('hex')
}

// Safety blocks in every repo and every mode; editorial objections only where
// `editorial` says the repo adopted omit, and margin reports them without blocking.
// load-bearing: this is the only place a verdict turns into pass or fail.
export function decide(r, { mode, editorial, scope = 'staged' }) {
  const safety = []
  const secrets = r.hazards.filter((h) => h.type === 'secret')
  if (secrets.length) safety.push(`${secrets.length} secret(s) ${scope}. Move to env/secrets manager, rotate if real, restage.`)
  if (r.hazards.some((h) => h.type === 'tls')) {
    safety.push(`TLS-verification bypass ${scope}. Point TLS at the CA bundle instead of switching verification off, or mark a reviewed line with omit-allow: <reason>.`)
  }
  const objections = []
  if (editorial) {
    if (r.receiptFailures.length) {
      objections.push(
        `${r.receiptFailures.length} receipt(s) in ${LEDGER} did not survive their own check — a refuted claim is a fabricated citation:\n` +
          r.receiptFailures.map((f) => `  line ${f.at} (${f.claim ?? 'no claim'}): ${f.checks.filter((c) => c.ok === false).map((c) => c.detail).join('; ')}`).join('\n') +
          `\nFix the receipt or the code it cites, then re-run.`
      )
    }
    if (r.uncitedDeps.length) {
      objections.push(
        `new dep(s) without a verified receipt: ${r.uncitedDeps.map((d) => d.dep).join(', ')}.` +
          (r.ledgerInChange
            ? ''
            : `\n   ${LEDGER} is not part of this commit — receipts are read from the index, so a ledger that is not being committed cites nothing.`) +
          `\nAdd one line to ${LEDGER} naming the dep and the omission you tried (each entry is re-checked, and must NOT hold):\n` +
          // The printed line has to be a receipt that verifies: a template whose
          // shape the checker rejects leaves an agent that followed it verbatim
          // blocked on its own instructions. `absent` names a symbol the checker
          // searches the whole tracked tree for, and the claim survives only if the
          // search comes back empty — so replace it with the symbol you actually
          // looked for.
          `  {"claim":"new-dep","rung":7,"dep":"${r.uncitedDeps[0].dep}","tried":[{"rung":2,"absent":"<symbol you searched for>"}]}\n` +
          `Run \`omit verify\` to check it before committing.`
      )
    }
    if (r.hazards.some((h) => h.type === 'injection')) {
      objections.push(`injection-prone lines ${scope}. Parameterize, use safe APIs, or mark reviewed lines with omit-allow: <reason>.`)
    }
    const lintFails = (r.lint ?? []).filter((l) => !l.ok)
    if (lintFails.length) objections.push(`the repo's own linter is failing on ${scope} files.\n${lintFails.map((l) => `[${l.linter}]\n${l.output}`).join('\n')}`)
  }
  return { ok: safety.length === 0 && (objections.length === 0 || mode === 'margin'), safety, objections }
}

// What the verdict names, as plain rows: no line text (a secret must not be
// echoed into a log) and nothing that varies between machines.
export function findingsOf(r, editorial) {
  const rows = r.hazards.filter((h) => editorial || h.type !== 'injection').map((h) => ({ kind: 'hazard', type: h.type, rule: h.rule, commit: h.commit ?? null }))
  if (editorial) {
    for (const f of r.receiptFailures) rows.push({ kind: 'receipt', rule: 'refuted', detail: `line ${f.at}` })
    for (const d of r.uncitedDeps) rows.push({ kind: 'dep', rule: 'uncited', detail: d.dep })
    for (const l of r.lint ?? []) if (!l.ok) rows.push({ kind: 'lint', rule: l.linter })
  }
  return rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
}

// Same inputs, byte-identical output: keys sorted at every depth, and the object
// carries no timestamp and no absolute path. `exec: false` marks a verdict made
// without running receipts or lint, so two runs are only comparable like for like.
export const canonical = (v) =>
  JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x), 2)

export const verdictOf = ({ version, base, head, adopted, mode, exec, r, editorial }, decision) => ({
  omitVersion: version,
  rulesHash: rulesHash(),
  base,
  head,
  adopted,
  mode,
  exec,
  ok: decision.ok,
  findings: findingsOf(r, editorial),
})
