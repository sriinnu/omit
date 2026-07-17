// Hazard scanning: hardcoded secrets and injection-prone patterns in added lines.
// Heuristics raise objections, not verdicts: suppress a reviewed line with `omit-allow: <reason>`.

const SECRET_RULES = [
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['stripe-live-key', /sk_live_[A-Za-z0-9]{20,}/],
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{32,}/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['hardcoded-credential', /(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{16,}["']/i],
]

const INJECTION_RULES = [
  ['eval', /\beval\s*\(/],
  ['new-function', /new\s+Function\s*\(/],
  ['shell-concat', /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|[^)"'`]*\+)/],
  ['subprocess-shell-true', /subprocess\.(?:run|call|Popen)\s*\(.*shell\s*=\s*True/],
  ['os-system-dynamic', /os\.system\s*\(\s*(?:f["']|[^)"']*\+)/],
  ['inner-html', /\.innerHTML\s*=|dangerouslySetInnerHTML/],
  ['pickle-load', /pickle\.loads?\s*\(/],
  ['yaml-unsafe-load', /yaml\.load\s*\((?![^)]*SafeLoader)/],
]

const sqlInjection = (line) =>
  /\b(?:execute|query|raw)\s*\(/i.test(line) &&
  /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(line) &&
  (/\$\{/.test(line) || /["'`]\s*\+/.test(line) || /f["']/.test(line) || /%\s*\(/.test(line))

export function findHazards(lines) {
  const findings = []
  lines.forEach((text, i) => {
    if (text.includes('omit-allow:')) return
    for (const [rule, re] of SECRET_RULES) {
      if (re.test(text)) findings.push({ type: 'secret', rule, line: i + 1, text: text.trim().slice(0, 120) })
    }
    for (const [rule, re] of INJECTION_RULES) {
      if (re.test(text)) findings.push({ type: 'injection', rule, line: i + 1, text: text.trim().slice(0, 120) })
    }
    if (sqlInjection(text)) findings.push({ type: 'injection', rule: 'sql-string-built', line: i + 1, text: text.trim().slice(0, 120) })
  })
  return findings
}
