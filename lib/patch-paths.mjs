// Codex reports apply_patch as tool_input.command, not file_path.
// Return null for other tools; deletions have no surviving file to inspect.
export function patchPaths(data) {
  if (data.tool_name !== 'apply_patch') return null
  const patch = data.tool_input?.command
  // load-bearing: malformed patch payloads must not silently pass inspection.
  if (typeof patch !== 'string') throw new Error('apply_patch requires tool_input.command')
  const lines = patch.trim().split(/\r?\n/)
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new Error('unrecognized apply_patch envelope')
  }
  const paths = new Set()
  let current = null
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      current = header[1] === 'Delete' ? null : header[2]
      if (current) paths.add(current)
    } else if (line.startsWith('*** Move to: ')) {
      if (!current) throw new Error('patch move without a source file')
      paths.delete(current)
      current = line.slice('*** Move to: '.length)
      if (!current) throw new Error('patch move without a destination')
      paths.add(current)
    }
  }
  return [...paths]
}
