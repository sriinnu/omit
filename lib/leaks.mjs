// Secret-leak detection: commands that print an EXISTING secret's raw value to
// stdout — keychain/vault reads, env dumps, credential-file cats, or a live key
// typed straight into a command line. Different from hazards.mjs (which catches
// secrets typed INTO files): this catches secrets pulled OUT of a store (or
// pasted directly) and echoed to the terminal, where they land in the agent's
// own transcript. Suppress a reviewed command with: # omit-allow: <reason>
//
// Known limitation, by design rather than oversight: this is a text-regex
// scanner with no shell evaluation. A command that hides a matched substring
// behind computation — base64/hex decode then `bash -c`/`eval`, ANSI-C
// hex-escaped filenames ($'\x2e\x65...'), a secret built by concatenating
// shell variables before use — produces no findings even though it's
// semantically identical to a command this file does catch verbatim. Closing
// that class requires actually evaluating the command (a shell interpreter or
// AST parser), which is out of scope for a lightweight PreToolUse heuristic;
// raising this bar is the goal, not a guarantee against a deliberately evasive
// agent or a malicious actor steering one.
import { SECRET_RULES } from './hazards.mjs'

// A redirect counts as "suppressed" if the command's own stdout doesn't reach
// the terminal/tool output at all — `&>/dev/null`, `>/dev/null`, `>>logfile`,
// `> anyfile`. The mission here is transcript-scoped ("don't print a secret
// into the conversation"), not disk-scoped, so redirecting to a real file
// counts as safe even though it still leaves a plaintext secret on disk — a
// different, lesser problem than this hook exists to catch.
// `2>/dev/null` alone only hides stderr — the secret still prints on success —
// so a redirect must not be preceded by a digit other than `1` to count.
const STDOUT_REDIRECTED_RE = /&>\s*\S+|>>\s*\S+|(?:(?<![0-9])>|1>)\s*\S+/

// Piping into one of these consumes the value without ever printing it back —
// clipboard tools and the --password-stdin/--from-file=/dev/stdin idiom exist
// specifically so a secret never has to be echoed or shown in `ps`.
const SAFE_SINK_RE =
  /\|\s*(?:pbcopy\b|xclip\b|wl-copy\b|clip(?:\.exe)?\b|docker\s+login\b[^\n]*--password-stdin\b|kubectl\s+create\s+secret\b[^\n]*--from-file=\/dev\/stdin\b)/i

// Naive split on top-level statement separators (&&, ||, ;, newline) — NOT
// pipe, since a pipe chain is one data-flow unit we reason about via
// SAFE_SINK_RE instead of splitting apart. Doesn't respect quoting or subshell
// nesting: a heuristic scoping improvement over checking the whole command at
// once, not a shell parser. Known gap: a redirect that lives after `done` on a
// multi-line `for ...; do ...; done > file` loop isn't attributed back to the
// loop body, since `;`/newline splits the loop apart from its own redirect —
// that idiom will false-positive here; reach for `# omit-allow:` if you hit it.
const splitClauses = (command) => command.split(/&&|\|\||;|\n/)

const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist']
// Formats that are never a credential store themselves, even when the
// filename literally contains "secrets" (a doc *about* secrets management).
const DOC_EXTENSIONS = ['.md', '.markdown', '.mdx', '.rst', '.adoc']
// Standard Let's Encrypt / ACME naming for the PUBLIC half of a TLS chain —
// only the private key (privkey.pem, key.pem, *.key) is actually sensitive.
const PUBLIC_CERT_BASENAMES = ['fullchain.pem', 'chain.pem', 'cert.pem', 'certificate.pem', 'ca.pem', 'ca-bundle.pem', 'ca-cert.pem', 'ca-certificates.pem']

const KEYCHAIN_DUMP_RE = /\bsecurity\s+dump-keychain\b/
const KEYCHAIN_READ_RE = /\bsecurity\s+find-(?:generic|internet)-password\b[^|;&\n]*-w\b/
// Captures the redirect target directly (not by re-embedding STDOUT_REDIRECTED_RE,
// which already consumes its own \S+ target internally — nesting it here would
// require a second, spurious \S+ after an already-complete match).
// Target capture excludes ;&| (not just whitespace) so it doesn't swallow a
// following statement separator when there's no space before it, e.g.
// `-w > /tmp/x.txt;cat /tmp/x.txt` — a bare \S+ would capture "/tmp/x.txt;"
// and then never match that string against the later bare "/tmp/x.txt".
const KEYCHAIN_REDIRECTED_RE = /-w\b[^|;&\n]*(?:&>|>>|(?:(?<![0-9])>|1>))\s*([^\s;&|]+)/
// \w+ and [^)]* below are bounded (not unbounded) on purpose: an unbounded
// quantifier that can match a long run of word characters, tried starting at
// every position in a long non-matching string (e.g. a long token with no `=`
// anywhere), backtracks character-by-character at each start position — O(n)
// positions x O(n) backtrack = O(n^2). A real shell variable/function name or
// a security-call argument list is never remotely close to these bounds.
const ASSIGN_CAPTURE_RE = /(\w{1,64})=\$\(\s*security\s+find-(?:generic|internet)-password\b[^)]{0,2048}-w[^)]{0,2048}\)/
const TEST_CAPTURE_RE = /(?:-n|\bif\b|\btest\b)\s+"?\$\(\s*security\s+find-(?:generic|internet)-password\b[^)]{0,2048}-w[^)]{0,2048}\)"?/

// Left boundary is explicit (whitespace/start/;&|() rather than bare \b, which
// would match "env" inside a filename like ".env" (a "." IS a \b boundary).
const ENV_BARE_RE = /(?:^|[\s;&|(])(env|printenv)\b\s*($|[;&])/
const PRINTENV_VAR_RE = /(?:^|[\s;&|(])printenv\s+[A-Za-z_][A-Za-z0-9_]*\b/
const ENV_GREP_RE = /(?:^|[\s;&|(])(?:env|printenv)\b\s*\|\s*(?:e|f)?grep\b([^|;&\n]*)/i
const ENV_SECRET_WORD_RE = /^(api|access|secret|private|auth|db|aws|gcp)?(key|token|secret|password|credential)s?$/i
// Connection-string-style var names (DATABASE_URL, MONGODB_URI, REDIS_URL,
// FOO_DSN) commonly embed a username:password, unlike a generic *_URL such as
// API_URL or WEBHOOK_URL — so this requires a recognized data-store prefix
// rather than treating any bare "url"/"uri" as sensitive.
const CONNECTION_STRING_RE = /\b(?:database|db|mongo|mongodb|redis|postgres|postgresql|mysql|amqp|rabbitmq)_?(?:url|uri)\b|\bdsn\b|\bconnection_?string\b/i
// -q/-c/-l/-L never print the matched line's value, only a boolean/count/filename.
const GREP_SAFE_FLAGS_RE = /(?:^|\s)-[a-zA-Z]*[qcl][a-zA-Z]*(?:\s|$)|--quiet\b|--count\b|--files-with-matches\b|--files-without-match\b/

// grep-family tools print matching lines from a file's content just like cat
// does when given a credential file as the target — included here (unlike in
// SEARCH_TOOL_RE below, which is about a secret-SHAPED STRING used as a search
// pattern, a different concern).
const READ_CMDS_RE = /\b(cat|less|more|head|tail|bat|grep|egrep|fgrep|rg|ag|ack)\b/
const GREP_FAMILY_RE = /\b(?:grep|egrep|fgrep|rg|ag|ack)\b/
const SECRET_FILE_RE = /(?<![\w.-])(?:[\w./~-]*\/)?(\.env(?:\.[\w-]+)?|credentials(?:\.json)?|secrets\.[\w-]+|[\w.-]+\.pem|[\w.-]*_rsa|id_rsa)(?![\w.-])/gi
// Cap on how long a single whitespace-separated token gets tested against
// SECRET_FILE_RE. Without this, a single very long non-matching argument (a
// long path-like string with no real extension) drives the regex — its
// optional path-prefix combined with re-scanning from every failed position —
// into ~O(n^2) time: a plain `cat` of a ~200KB argument was measured to hang
// for over a minute. No legitimate filename is anywhere near this long.
const MAX_FILENAME_TOKEN_LENGTH = 512

// Commands that scan/search text rather than transmit it: a secret-shaped
// string used as a search pattern (a security audit grepping for a known
// placeholder to remove it) isn't a live secret being set or sent anywhere.
const SEARCH_TOOL_RE = /^\s*(?:sudo\s+)?(?:grep|egrep|fgrep|rg|ag|ack)\b/
// Widely-published placeholder values from official vendor docs/examples —
// never real credentials, exact-match only so a genuine key sharing the same
// prefix still gets caught.
const KNOWN_PLACEHOLDER_SECRETS = new Set(['AKIAIOSFODNN7EXAMPLE'])

// Secret-fetch commands beyond macOS Keychain: Linux keyrings, password-store,
// gpg, and the common cloud/vault CLIs. Unlike the keychain rule above (which
// earned its precise capture/redirect scoping from a real script in
// production), these use one coarse per-clause safety check — omitted:
// deeper data-flow tracing for each of these until one has a real
// counter-example that needs it, same as the keychain rule once did.
const SECRET_FETCH_COMMANDS = [
  ['secret-tool-print', /\bsecret-tool\s+lookup\b/, null, '`secret-tool lookup` (Linux keyring) prints the secret to stdout.'],
  [
    'pass-show-print',
    /\bpass\s+(?:show\s+)?[A-Za-z][\w./-]*\b/,
    /\bpass\s+(generate|insert|edit|rm|remove|delete|git|ls|list|find|grep|init|mv|move|cp|copy|help|version|--help|--version)\b/,
    '`pass` (password-store) prints the decrypted secret to stdout.',
  ],
  [
    'gpg-decrypt-print',
    /\bgpg\s+(?:--decrypt\b|-[a-zA-Z]*d[a-zA-Z]*\b)/,
    /(?:-o\s|--output\b)/,
    '`gpg --decrypt` with no -o/--output target prints the decrypted plaintext to stdout.',
  ],
  ['1password-read-print', /\bop\s+(?:read\b|item\s+get\b[^\n]*(?:--fields|--reveal)\b)/, /--help\b|-h\b/, '1Password CLI (`op read` / `op item get --fields`) prints the secret value to stdout.'],
  ['aws-secretsmanager-print', /\baws\s+secretsmanager\s+get-secret-value\b/, null, '`aws secretsmanager get-secret-value` prints the SecretString to stdout.'],
  ['vault-read-print', /\bvault\s+(?:kv\s+get|read)\b/, null, '`vault kv get` / `vault read` prints secret data to stdout.'],
  ['gcloud-secret-print', /\bgcloud\s+secrets\s+versions\s+access\b/, null, '`gcloud secrets versions access` prints the secret payload to stdout.'],
  ['azure-keyvault-print', /\baz\s+keyvault\s+secret\s+show\b/, null, '`az keyvault secret show` prints the secret value to stdout.'],
  ['kubectl-secret-print', /\bkubectl\s+get\s+secrets?\b[^\n]*-o\s+(?:jsonpath|go-template|json|yaml)\b/, null, '`kubectl get secret -o jsonpath/json/yaml` dumps the secret\'s data field to stdout.'],
]

function grepTargetsSecret(argsStr) {
  if (GREP_SAFE_FLAGS_RE.test(argsStr)) return false
  if (CONNECTION_STRING_RE.test(argsStr)) return true
  const words = argsStr.split(/[^A-Za-z]+/).filter(Boolean)
  return words.some((w) => ENV_SECRET_WORD_RE.test(w))
}

function hasUnsafeSecretFileTarget(command) {
  // Test individual whitespace-separated tokens, not the whole command as one
  // blob — a credential filename is always a single token, so this loses no
  // detection while bounding each SECRET_FILE_RE call to a short string (see
  // MAX_FILENAME_TOKEN_LENGTH) and closing the quadratic-time DoS above.
  for (const rawToken of command.split(/\s+/)) {
    if (rawToken.length === 0 || rawToken.length > MAX_FILENAME_TOKEN_LENGTH) continue
    SECRET_FILE_RE.lastIndex = 0
    const m = SECRET_FILE_RE.exec(rawToken)
    if (!m) continue
    const token = m[1].toLowerCase()
    const base = token.split('/').pop()
    if (SAFE_ENV_SUFFIXES.some((suf) => token.endsWith(suf))) continue
    if (DOC_EXTENSIONS.some((ext) => token.endsWith(ext))) continue
    if (PUBLIC_CERT_BASENAMES.includes(base)) continue
    return true
  }
  return false
}

// Per-clause check for the coarser SECRET_FETCH_COMMANDS table: true if this
// clause's stdout is captured into a variable, redirected, or piped into a
// known non-printing sink, rather than printed bare.
function isCapturedOrRedirected(clause) {
  if (STDOUT_REDIRECTED_RE.test(clause)) return true
  if (SAFE_SINK_RE.test(clause)) return true
  // Bounded quantifiers — see the comment above ASSIGN_CAPTURE_RE for why.
  if (/\w{1,64}=\$\([^)]{0,2048}\)|\w{1,64}=`[^`]{0,2048}`/.test(clause)) return true
  return false
}

// True when a KEYCHAIN_READ_RE match sits as the sole statement in a shell
// function body (`name() {\n  security ... -w\n}`) AND that function is later
// called in a captured way (`$(name ...)`, `` `name ...` ``) — the standard
// idiom for a helper that returns its value via stdout/$(...) at the call
// site. Wrapping alone is NOT sufficient: a bare, uncaptured call to the
// function prints to stdout on invocation exactly like the unwrapped command
// would, so this requires positive evidence of a captured call, not just the
// absence of other statements in the body.
function isSoleStatementInFunctionBody(command, match) {
  const before = command.slice(0, match.index)
  const opener = /(\w{1,64})\s*\(\)\s*\{\s*$/.exec(before)
  if (!opener) return false
  const after = command.slice(match.index + match[0].length)
  if (!/^(?:\s*2?>&?1?\s*\/dev\/null)?\s*\n?\s*\}/.test(after)) return false
  const funcName = opener[1]
  const capturedCallRe = new RegExp(`\\$\\(\\s*${funcName}\\b|\`\\s*${funcName}\\b`)
  return capturedCallRe.test(command.slice(match.index + match[0].length))
}

export function assessLeak(command) {
  if (/omit-allow:/.test(command)) return []
  const findings = []
  const push = (rule, reason) => findings.push({ rule, reason })

  // A live secret typed directly into the command line — e.g. pasted into a
  // curl header — is dangerous regardless of redirects, since the command
  // itself (not just its output) lands in the tool's recorded input. Scoped
  // per clause (not "is the whole command a search-tool invocation") so a
  // harmless `grep ... &&` prefix can't suppress detection of a real secret
  // in a later, unrelated clause of the same compound command. Skipped only
  // for clauses that are themselves search-tool invocations (grep/rg/...): a
  // secret-shaped string there is almost always a search pattern (e.g.
  // auditing for a known placeholder), not a live value being set or sent.
  for (const clause of splitClauses(command)) {
    if (SEARCH_TOOL_RE.test(clause)) continue
    for (const [rule, re] of SECRET_RULES) {
      const m = re.exec(clause)
      if (m && !KNOWN_PLACEHOLDER_SECRETS.has(m[0])) {
        push(
          `literal-secret-${rule}`,
          `this command line contains what looks like a live ${rule.replace(/-/g, ' ')} — the value would be recorded in the transcript verbatim. Reference it via a variable or secrets manager instead of the literal, and rotate the key if it's real.`,
        )
      }
    }
  }

  if (KEYCHAIN_DUMP_RE.test(command)) {
    push('keychain-dump', '`security dump-keychain` prints every keychain item, secrets included. Look up one specific item instead.')
  }

  const keychainMatch = KEYCHAIN_READ_RE.exec(command)
  if (keychainMatch) {
    const assign = ASSIGN_CAPTURE_RE.exec(command)
    const redirect = KEYCHAIN_REDIRECTED_RE.exec(command)
    const tailFromMatch = command.slice(keychainMatch.index + keychainMatch[0].length)
    let safe = TEST_CAPTURE_RE.test(command) || isSoleStatementInFunctionBody(command, keychainMatch) || SAFE_SINK_RE.test(tailFromMatch)
    if (redirect) {
      // Redirected to a file (not /dev/null) is only safe if nothing later in
      // the command reads that same file back out — "write to a scratch file,
      // then cat it to double-check" is a real leak, not a suppression. Plain
      // substring search, not a rebuilt RegExp: the target is an unbounded,
      // command-controlled string, and interpolating it into a pattern risks
      // hitting V8's regex-size ceiling on a long path (a real, reproducible
      // crash — not hypothetical).
      const target = redirect[1]
      const tail = command.slice(redirect.index + redirect[0].length)
      const readMatch = READ_CMDS_RE.exec(tail)
      const rereadElsewhere = readMatch !== null && tail.slice(readMatch.index).includes(target)
      safe = safe || !rereadElsewhere
    }
    if (assign) {
      const varName = assign[1]
      const tail = command.slice(assign.index + assign[0].length)
      const echoedLater = new RegExp(`\\b(echo|printf|print|cat)\\b[^\\n]*\\$\\{?${varName}\\}?\\b`).test(tail)
      safe = !echoedLater || SAFE_SINK_RE.test(tail)
    }
    if (!safe) {
      push(
        'keychain-secret-print',
        '`security find-generic-password -w` prints the raw secret to stdout. Redirect it (`-w &>/dev/null`) to just ' +
          'check it exists, or capture it into a variable (`val=$(security find-generic-password -s NAME -w 2>/dev/null)`) without echoing it back.',
      )
    }
  }

  // Scoped per clause: an unrelated redirect on one clause of a compound
  // command must not suppress a real, unredirected printenv leak on another.
  let envDumpFound = false
  let printenvVarFound = false
  for (const clause of splitClauses(command)) {
    if (!envDumpFound && ENV_BARE_RE.test(clause)) {
      push('env-dump', 'bare `env`/`printenv` can print every secret-bearing variable in the shell. Check one variable with `[[ -n "$VAR" ]]` instead.')
      envDumpFound = true
    } else if (!printenvVarFound && PRINTENV_VAR_RE.test(clause) && !STDOUT_REDIRECTED_RE.test(clause)) {
      push('printenv-var-print', '`printenv <name>` prints that variable\'s raw value to stdout. Check with `[[ -n "$VAR" ]]` instead.')
      printenvVarFound = true
    }
  }
  const envGrep = ENV_GREP_RE.exec(command)
  if (envGrep && grepTargetsSecret(envGrep[1])) {
    push('env-grep-secret', '`env | grep` targeting a KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/connection-string variable prints its value, not just its name. Use `env | grep -q ...` or `[[ -n "$VAR" ]]` instead.')
  }

  for (const clause of splitClauses(command)) {
    if (!READ_CMDS_RE.test(clause) || STDOUT_REDIRECTED_RE.test(clause)) continue
    // grep-family's own value-suppressing flags (-c/-q/-l/-L) are exempt here
    // too — this is the tool's own recommended remediation for this rule.
    if (GREP_FAMILY_RE.test(clause) && GREP_SAFE_FLAGS_RE.test(clause)) continue
    if (hasUnsafeSecretFileTarget(clause)) {
      push(
        'credential-file-read',
        'this reads a file that looks like a credential store (.env, credentials, *.pem, id_rsa, secrets.*) with a command ' +
          'that prints its contents. Use `test -f <file>` to check it exists, or `grep -c "" <file>` to count lines, without printing contents.',
      )
      break // one finding per command for this rule, regardless of how many clauses match
    }
  }

  for (const [rule, matchRe, excludeRe, reason] of SECRET_FETCH_COMMANDS) {
    for (const clause of splitClauses(command)) {
      if (!matchRe.test(clause)) continue
      if (excludeRe && excludeRe.test(clause)) continue
      if (isCapturedOrRedirected(clause)) continue
      push(rule, `${reason} Capture it into a variable, or redirect stdout to a file, instead of letting it print bare.`)
      break
    }
  }

  return findings
}
