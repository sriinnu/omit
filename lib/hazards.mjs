// Hazard scanning: hardcoded secrets and injection-prone patterns in added lines.
// Heuristics raise objections, not verdicts: a reviewed *injection* line is
// suppressed with `omit-allow: <reason>`. Secrets have no override at all.

export const SECRET_RULES = [
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['stripe-live-key', /sk_live_[A-Za-z0-9]{20,}/],
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{32,}/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['chitragupta-key', /chg_[A-Za-z0-9_-]{20,}/],
  ['hardcoded-credential', /(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{16,}["']/i],
]

const INJECTION_RULES = [
  ['eval', /\beval\s*\(/],
  ['new-function', /new\s+Function\s*\(/],
  ['shell-concat', /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|[^)"'`]*\+)/],
  ['subprocess-shell-true', /subprocess\.(?:run|call|Popen)\s*\(.*shell\s*=\s*True/],
  ['os-system-dynamic', /os\.system\s*\(\s*(?:f["']|[^)"']*\+)/],
  // The character class is not decoration: spelled literally, this pattern
  // matches its own source text and the scanner reports the rule table.
  ['inner-html', /\.innerHTML\s*=|dangerouslySet[A-Za-z]*HTML/],
  ['pickle-load', /pickle\.loads?\s*\(/],
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

export const isAllowSuppressed = (text) =>
  ALLOW_MARKER_RE.test(text.trimEnd().replace(QUOTED_SPAN_RE, (m) => ' '.repeat(m.length)))

export function findHazards(lines) {
  const findings = []
  lines.forEach((text, i) => {
    for (const [rule, re] of SECRET_RULES) {
      if (re.test(text)) findings.push({ type: 'secret', rule, line: i + 1, text: text.trim().slice(0, 120) })
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
  })
  return findings
}
