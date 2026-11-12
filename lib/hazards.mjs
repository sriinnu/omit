// Hazard scanning: hardcoded secrets and injection-prone patterns in added lines.
// Heuristics raise objections, not verdicts: a reviewed *injection* line is
// suppressed with `omit-allow: <reason>`. Secrets have no override at all.
import { basename } from 'node:path'
import { findTls } from './tls.mjs'
import { isLockfile } from './deps.mjs'

// Widely-published placeholder values from AWS's own documentation (the IAM
// "access keys" and credentials-file examples) — never real credentials.
// Exact-match only, so a genuine key sharing the same prefix still gets caught.
// Assembled rather than written literally: these are key-shaped strings, and the
// scanner would flag the tool's own source.
export const KNOWN_PLACEHOLDER_SECRETS = new Set(['AKIA' + 'IOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY'])
// A placeholder counts only as a whole token: one followed by more key
// characters is a different, possibly real, string.
const PLACEHOLDER_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${[...KNOWN_PLACEHOLDER_SECRETS].map((k) => k.replace(/[/+]/g, '\\$&')).join('|')})(?![A-Za-z0-9/+_-])`, 'g')

// Paths the injection rules do not read: prose that names a banned call, vendored
// and minified code nobody here authored, and generated lockfiles. Secrets and
// TLS bypass are still scanned there.
export const isInjectionExempt = (path) =>
  /\.(?:md|mdx|rst|txt)$/i.test(path) || /(?:^|\/)(?:docs|vendor|third_party)\//.test(path) || /\.min\.(?:js|css)$/i.test(path) || isLockfile(basename(path))

export const SECRET_RULES = [
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['stripe-live-key', /sk_live_[A-Za-z0-9]{20,}/],
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{32,}/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['url-credential', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s/@'"$<{]{3,}@[\w.-]+/i],
  ['chitragupta-key', /chg_[A-Za-z0-9_-]{20,}/],
  ['hardcoded-credential', /(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{16,}["']/i],
  // Unquoted, as YAML and .env files write it.
  ['unquoted-credential', /^\s*(?:password|passwd|secret|api[_-]?key)\s*[:=][ \t]*[^\s'"$<{][^\s#]{11,}\s*$/im],
]

const INJECTION_RULES = [
  ['eval', /\beval\s*\(/],
  ['new-function', /(?:new\s+|\b)Function\s*\(\s*["'`]/],
  // Both shapes of a string built for a shell: a template with ${…}, or a literal joined with +.
  ['shell-concat', /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|[^)]*["'`]?\s*\+)/],
  ['subprocess-shell-true', /subprocess\.(?:run|call|Popen)\s*\(.*shell\s*=\s*True/],
  ['os-system-dynamic', /os\.system\s*\(\s*(?:f["']|[^)]*\+)/],
  // The character class is not decoration: spelled literally, this pattern
  // matches its own source text and the scanner reports the rule table.
  ['inner-html', /\.innerHTML\s*=(?!\s*(?:''|""|``)\s*(?:[;)\n]|$))|dangerouslySet[A-Za-z]*HTML/],
  ['pickle-load', /\b(?:pickle|marshal)\.loads?\s*\(/],
  ['yaml-unsafe-load', /yaml\.load\s*\((?![^)]*SafeLoader)/],
]

const sqlInjection = (line) =>
  /\b(?:execute|query|raw)\s*\(/i.test(line) &&
  /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(line) &&
  (/\$\{/.test(line) || /["'`]\s*\+/.test(line) || /f["']/.test(line) || /%\s*\(/.test(line))

// The reviewed-line marker, shared with danger.mjs and leaks.mjs so one form
// means one thing everywhere. Three properties turn it from free text into a
// review:
//   - it must be a comment, not a substring: quoted spans are blanked first, so
//     `echo "omit-allow:"` and `const s = "// omit-allow: nope"` don't count;
//   - it must carry a reason — the docs have always said `omit-allow: <reason>`,
//     and a bare token costs a reviewer nothing;
//   - it must be the trailing comment, so what it covers is what precedes it;
//     a marker buried mid-command (or on an earlier line of a multi-line
//     command) reads as text, not as the documented `append: # omit-allow: …`.
// It is deliberately NOT wired to SECRET_RULES — see findHazards.
const QUOTED_SPAN_RE = /"(?:[^"\\]|\\.)*"|'[^']*'/g
const ALLOW_MARKER_RE = /(?:^|[\s;&|])(?:\/\/|#)[ \t]*omit-allow:[ \t]*\S[^\n]*$/

// The quoted-span scan above goes quadratic on an unclosed quote, and a hook
// that outlives the harness's timeout lets the command through. No command an
// agent means to run is this long, so a longer one is blocked as unreadable.
// load-bearing: the bound keeps a hostile command from timing the sentinels out.
export const MAX_COMMAND = 64_000
export const TOO_LONG = `omit blocks this command: it is over ${MAX_COMMAND} characters, too long to check in time. Write long content with the Write tool, then run it.`

export const isAllowSuppressed = (text) =>
  ALLOW_MARKER_RE.test(text.trimEnd().replace(QUOTED_SPAN_RE, (m) => ' '.repeat(m.length)))

export function findHazards(lines) {
  const findings = []
  lines.forEach((text, i) => {
    const bare = text.replace(PLACEHOLDER_RE, '')
    for (const [rule, re] of SECRET_RULES) {
      if (re.test(bare)) findings.push({ type: 'secret', rule, line: i + 1, text: text.trim().slice(0, 120) })
    }
    // Secrets are scanned before the marker runs, on purpose: `omit-allow:`
    // restores a reviewed judgement call, and a hardcoded key is not one. The
    // README's "Secrets have no override" is true only while this line stays
    // below that loop.
    if (isAllowSuppressed(text)) return
    for (const [rule, re] of INJECTION_RULES) {
      if (re.test(text)) findings.push({ type: 'injection', rule, line: i + 1, text: text.trim().slice(0, 120) })
    }
    if (sqlInjection(text)) findings.push({ type: 'injection', rule: 'sql-string-built', line: i + 1, text: text.trim().slice(0, 120) })
    for (const rule of findTls(text)) findings.push({ type: 'tls', rule, line: i + 1, text: text.trim().slice(0, 120) })
  })
  return findings
}
