// Shared manifest/dependency detection for the hooks, `omit audit`, and the bench.
//
// Dependencies are read by PARSING each manifest's declared dependency tables,
// never by matching diff lines. Line matching fails in both directions: a
// minified one-line package.json matches no line pattern (a false pass on a real
// dependency), while `"version": "1.0.0"` matches the version-range pattern (a
// false objection to metadata). Formatting is not a dependency, so neither
// spelling should change the verdict.
//
// Pure functions only — content in, dependency names out. Callers get the two
// revisions' contents from lib/git.mjs.
import { basename } from 'node:path'

export const MANIFESTS = new Set([
  'package.json', 'requirements.txt', 'requirements-dev.txt', 'pyproject.toml',
  'setup.cfg', 'Pipfile', 'environment.yml', 'environment.yaml', 'go.mod',
  'Cargo.toml', 'Gemfile', 'composer.json',
])

export const isManifest = (path) => MANIFESTS.has(basename(path))

// Dependency-shaped files we still cannot read. A file that declares
// dependencies and is not parsed has to be reported by name, because `new deps:
// 0 ✅` for a manifest we never opened is the same silent pass as a missed
// dependency. Lockfiles are generated, not authored, so they are no gap.
// omitted: setup.py / build.gradle / *.csproj parsing; the predicate reports
// them instead. Add a parser the day one of them is actually depended on.
const UNPARSED_DEPENDENCY_FILES = new Set(['setup.py', 'build.gradle', 'build.gradle.kts', 'Package.swift'])
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'paket.lock', 'packages.lock.json'])

export const unparsedDependencyFile = (path) => {
  const name = basename(path)
  if (LOCKFILES.has(name) || name.endsWith('.lock')) return false
  return UNPARSED_DEPENDENCY_FILES.has(name) || name.endsWith('.csproj')
}

// Dependency names declared in `after` that were not declared in `before`.
// A manifest that did not exist before declares everything as new — pass ''.
export function addedDeps(manifestName, before, after) {
  const had = new Set(parseDeps(manifestName, before))
  return parseDeps(manifestName, after).filter((d) => !had.has(d))
}

export function parseDeps(manifestName, content) {
  if (!content) return []
  // npm and conda read a BOM-terminated manifest fine, JSON.parse does not, and
  // a parser that rejects the file falls back to guessing. One strip here keeps
  // every format honest about what it declares.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  switch (manifestName) {
    case 'package.json':
    case 'composer.json':
      return jsonDeps(text)
    case 'requirements.txt':
    case 'requirements-dev.txt':
      return requirementDeps(text)
    case 'go.mod':
      return goModDeps(text)
    case 'Cargo.toml':
      return tomlDeps(text, cargoTables)
    case 'pyproject.toml':
      return tomlDeps(text, pyprojectTables)
    case 'Pipfile':
      return tomlDeps(text, pipfileTables)
    case 'environment.yml':
    case 'environment.yaml':
      return condaDeps(text)
    case 'setup.cfg':
      return setupCfgDeps(text)
    case 'Gemfile':
      return gemfileDeps(text)
    default:
      return []
  }
}

// ---- package.json / composer.json ----
// Both declare dependencies as named objects at fixed top-level keys; composer
// spells them `require`/`require-dev`. Parsing the JSON is what makes a minified
// manifest and a pretty-printed one declare the same set.
const JSON_DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'require', 'require-dev']
const JSON_BUNDLE_KEYS = ['bundledDependencies', 'bundleDependencies']
const JSON_TABLE_KEYS = new Set([...JSON_DEP_KEYS, ...JSON_BUNDLE_KEYS])

function jsonDeps(content) {
  let doc
  try {
    doc = JSON.parse(content)
  } catch {
    return jsonFallbackDeps(content)
  }
  const names = new Set()
  for (const key of JSON_DEP_KEYS) {
    const table = doc?.[key]
    if (table && typeof table === 'object') for (const name of Object.keys(table)) names.add(name)
  }
  for (const key of JSON_BUNDLE_KEYS) {
    if (Array.isArray(doc?.[key])) for (const name of doc[key]) names.add(name)
  }
  return [...names]
}

// The fallback covers a partial write or JSON5-ish syntax npm tolerates. It has
// to stay table-scoped: scanning every quoted key/version pair reports the
// manifest's own metadata as a dependency, and narrowing that scan to
// version-shaped values instead loses `"left-pad": "latest"`. So walk the
// text's strings and brackets and read only the dependency tables out of them.
function jsonFallbackDeps(content) {
  const tokens = jsonTokens(content)
  const names = new Set()
  let depth = 0
  let root = -1 // a truncated manifest can be missing its root brace
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].t
    if (token === '{' || token === '[') { depth++; continue }
    if (token === '}' || token === ']') { depth--; continue }
    if (token !== 's' || tokens[i + 1]?.t !== ':') continue
    if (root < 0) root = depth
    if (depth !== root || !JSON_TABLE_KEYS.has(tokens[i].v)) continue
    const value = tokens[i + 2]
    if (value?.t === '{' || value?.t === '[') for (const n of spanNames(tokens, i + 2, value.t === '{')) names.add(n)
  }
  return [...names]
}

// Strings and structural characters, in order — enough structure to scope a
// lookup to a table without a JSON parser.
function jsonTokens(content) {
  const tokens = []
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (c !== '"' && c !== "'") {
      if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':') tokens.push({ t: c })
      continue
    }
    let v = ''
    for (i++; i < content.length && content[i] !== c; i++) v += content[i] === '\\' ? content[++i] ?? '' : content[i]
    tokens.push({ t: 's', v })
  }
  return tokens
}

// The strings of one value span: an object's keys (`object`, when the value is
// a table), or every string in an array (`bundledDependencies`).
function spanNames(tokens, start, object) {
  const out = []
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i].t
    if (t === '{' || t === '[') depth++
    else if (t === '}' || t === ']') { if (--depth === 0) break }
    else if (depth === 1 && t === 's' && (!object || tokens[i + 1]?.t === ':')) out.push(tokens[i].v)
  }
  return out
}

// ---- requirements.txt ----
// Line-oriented: a name, then optionally extras, a version specifier, or an
// environment marker. Options (-r, -e, --hash) and comments declare nothing.
// omitted: PEP 503 name folding (foo_bar == foo-bar): lowercasing covers the
// installed spelling; add folding if a repo is ever bitten by the other.
function requirementDeps(content) {
  const names = []
  for (const raw of content.split('\n')) {
    const line = raw.split('#')[0].trim()
    if (!line || line.startsWith('-')) continue
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)
    if (m) names.push(m[1].toLowerCase())
  }
  return [...new Set(names)]
}

// ---- go.mod ----
// Modules live in a `require ( ... )` block or a single-line `require x v1.2.3`.
// The `go`/`toolchain` directives name no module.
function goModDeps(content) {
  const names = []
  let block = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue
    if (block) {
      if (line === ')') { block = false; continue }
      const m = line.match(/^([^\s]+)\s+v\d/)
      if (m) names.push(m[1])
      continue
    }
    if (line === 'require (') { block = true; continue }
    const m = line.match(/^require\s+([^\s]+)\s+v\d/)
    if (m) names.push(m[1])
  }
  return [...new Set(names)]
}

// ---- Cargo.toml / pyproject.toml / Pipfile ----
// TOML is table-scoped, and table membership is what decides whether a key names
// a dependency: `version = "1.0.0"` under [package] is the crate's own version,
// while the same line under [dependencies] would declare a package called
// "version". `names(table, key, value)` returns the dependencies a key declares;
// key is null on a table header, which is how [dependencies.serde] is read.
function tomlDeps(content, names) {
  const out = new Set()
  const lines = content.split('\n')
  let table = ''
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim()
    if (!line) continue
    const header = line.match(/^\[\[?([^\]]+)\]\]?$/)
    if (header) {
      table = header[1].trim()
      for (const n of names(table, null, '')) out.add(n)
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_"'.-]+)\s*=\s*(.*)$/)
    if (!kv) continue
    let value = kv[2]
    // An array may span lines (`dependencies = [` … `]` in pyproject). Depth is
    // tracked as each line is appended: re-scanning the whole accumulator per
    // line is quadratic (40k lines cost >1s), and a line that opens a table or
    // assigns a key ends the array — otherwise an unclosed `[` swallows the rest
    // of the file and hands its `version = "1.0.0"` back as a dependency name.
    if (value.startsWith('[')) {
      let depth = bracketDepth(value)
      while (depth > 0 && i + 1 < lines.length) {
        const next = lines[i + 1]
        if (tomlRow(next) || value.length > TOML_VALUE_MAX) break
        i++
        depth += bracketDepth(next)
        value += '\n' + next
      }
    }
    for (const n of names(table, kv[1].replace(/^["']|["']$/g, ''), value)) out.add(n)
  }
  return [...out]
}

// `workspace.` is the shared table every member crate resolves through, so a
// dependency declared there is a dependency of the repo. TOML also allows any
// key to be quoted, nested table names included.
const CARGO_DEP_TABLE = /^(?:workspace\.)?(?:target\..+\.)?(?:dev-|build-)?dependencies$/
const CARGO_NESTED = /^(?:workspace\.)?(?:target\..+\.)?(?:dev-|build-)?dependencies\.(["']?)([A-Za-z0-9_-]+)\1$/

function cargoTables(table, key) {
  const nested = table.match(CARGO_NESTED)
  if (nested) return key === null ? [nested[2]] : []
  return CARGO_DEP_TABLE.test(table) && key !== null ? [key] : []
}

function pyprojectTables(table, key, value) {
  if (key === null) return []
  if (table === 'project' && key === 'dependencies') return specNames(value)
  if (table === 'project.optional-dependencies' || table === 'dependency-groups') return specNames(value)
  if (table === 'build-system' && key === 'requires') return specNames(value)
  if (table === 'tool.poetry.dependencies' || /^tool\.poetry\.group\..+\.dependencies$/.test(table)) {
    return key === 'python' ? [] : [key] // poetry's `python` key is an interpreter constraint
  }
  return []
}

// Names out of an array of PEP 508 specifiers: "requests[security]>=2.31".
const specNames = (value) => [...value.matchAll(/["']([^"']+)["']/g)].flatMap((m) => m[1].match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1].toLowerCase() ?? [])

// ---- Pipfile ----
// TOML, but only two of its tables declare packages: [requires] pins the
// interpreter and [[source]] describes an index.
const pipfileTables = (table, key) =>
  key !== null && (table === 'packages' || table === 'dev-packages') ? [key] : []

// ---- environment.yml / environment.yaml ----
// A conda environment lists its packages under the top-level `dependencies:`,
// as `name`, `name=1.2` or `name>=1.2`; a pip list nests one level deeper. An
// item that ends in `:` is a nested mapping key, not a package.
function condaDeps(content) {
  const names = []
  let list = false
  for (const raw of content.split('\n')) {
    const line = raw.split('#')[0]
    if (!line.trim()) continue
    if (line.trimStart() === line) { list = /^dependencies\s*:/.test(line); continue }
    if (!list || /:\s*$/.test(line)) continue
    const m = line.trim().replace(/^-\s*/, '').match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)
    if (m) names.push(m[1].toLowerCase())
  }
  return [...new Set(names)]
}

// ---- setup.cfg ----
// INI, not TOML. Requirement specs are the continuation lines of
// `install_requires` under [options], and of every key under
// [options.extras_require]; a key sits at column 0, its value below it.
function setupCfgDeps(content) {
  const names = []
  let table = ''
  let list = false
  for (const raw of content.split('\n')) {
    const line = raw.split('#')[0].trim()
    if (!line) continue
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) { table = header[1].trim(); list = false; continue }
    const kv = raw.trimStart() === raw ? line.match(/^([^=]+?)\s*=\s*(.*)$/) : null
    if (kv) {
      list = (table === 'options' && kv[1].trim() === 'install_requires') || table === 'options.extras_require'
      if (list) names.push(...requirementDeps(kv[2]))
      continue
    }
    if (list) names.push(...requirementDeps(line))
  }
  return [...new Set(names)]
}

// ---- Gemfile ----
// `gem 'name', '~> 7.0'` — every further argument is a version constraint.
function gemfileDeps(content) {
  const names = []
  for (const raw of content.split('\n')) {
    const m = stripComment(raw).trim().match(/^gem\s+['"]([^'"]+)['"]/)
    if (m) names.push(m[1])
  }
  return [...new Set(names)]
}

// ---- helpers ----
// Bounds a multi-line array. Real manifests are orders of magnitude smaller;
// anything past this is malformed or hostile, and swallowing it has no value.
const TOML_VALUE_MAX = 1 << 20

// How far a value string is from closing its brackets, counted once per line.
const bracketDepth = (s) => {
  let d = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') d++
    else if (s[i] === ']') d--
  }
  return d
}

// A line that opens a table or assigns a key cannot be an array element, so it
// closes an array that is still looking for its bracket. Tables are end-anchored
// because a quoted spec may itself start with `[` — `"requests[security]>=2.31"`.
const tomlRow = (line) => /^\s*(?:\[[^\]]*\]\s*$|(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=)/.test(stripComment(line))

// A `#` inside a quoted string is not a comment — poetry and uv pin git deps as
// `"pkg @ git+https://host/repo#subdirectory=lib"`.
function stripComment(line) {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = '' } else if (c === '"' || c === "'") quote = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}
