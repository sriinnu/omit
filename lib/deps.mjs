// Shared manifest/dependency detection for hooks and `omit audit`.
import { basename } from 'node:path'

const MANIFESTS = new Set([
  'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod',
  'Cargo.toml', 'Gemfile', 'composer.json',
])

export const isManifest = (path) => MANIFESTS.has(basename(path))

// Extracts dependency names that are genuinely NEW in a unified diff of one
// manifest: present in added lines and absent from removed lines (a dep whose
// line was merely reformatted: trailing comma, version bump: is not new).
// omitted: full manifest parsing: heuristics per format are enough to raise an
// objection; false negatives are acceptable, the agent's own rules still apply.
export function addedDeps(manifestName, diff) {
  const side = (prefix) =>
    depsIn(
      manifestName,
      diff
        .split('\n')
        .filter((l) => l.startsWith(prefix) && !l.startsWith(prefix.repeat(3)))
        .map((l) => l.slice(1).trim())
    )
  const removed = new Set(side('-'))
  return side('+').filter((d) => !removed.has(d))
}

function depsIn(manifestName, lines) {
  const out = []
  for (const line of lines) {
    let m = null
    switch (manifestName) {
      case 'package.json':
      case 'composer.json':
        // dep values start with a version range (^1.2, ~3, >=2, 1.0): script lines don't
        m = line.match(/^"(@?[a-z0-9._/-]+)"\s*:\s*"[~^><=]?\d/i)
        break
      case 'requirements.txt':
        m = line.match(/^([A-Za-z0-9._-]+)\s*(?:[><=~[]|$)/)
        break
      case 'go.mod':
        m = line.match(/^(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v\d/)
        break
      case 'Cargo.toml':
      case 'pyproject.toml':
        m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*["{]/)
        break
      case 'Gemfile':
        m = line.match(/^gem\s+['"]([\w-]+)['"]/)
        break
    }
    if (m) out.push(m[1])
  }
  return [...new Set(out)]
}
