// What an edit tool is about to write, read from its input before it lands, so
// a PreToolUse hook can object to a change instead of to its aftermath. Shapes:
//
//   Write         { content }
//   Edit          { old_string, new_string, replace_all? }
//   MultiEdit     { edits: [{ old_string, new_string, replace_all? }] }
//   NotebookEdit  { new_source }
//
// null means "not an edit shape this can read": the caller decides what that
// is worth, because for a hazard it is nothing to scan and for a hooks file it
// is an edit nobody could check.
const isStr = (s) => typeof s === 'string'
const editsOf = (ti) => (Array.isArray(ti.edits) ? ti.edits : isStr(ti.new_string) ? [ti] : null)
const fresh = (before, after) => {
  const old = new Set(before.split('\n'))
  return after.split('\n').filter((l) => !old.has(l))
}

// The whole file as it will read after the edit. An old_string the file does
// not hold is null too: the tool refuses that edit itself.
export function proposedText(ti, current) {
  if (isStr(ti.content)) return ti.content
  const edits = editsOf(ti)
  if (!edits || current === null) return null
  let text = current
  for (const e of edits) {
    if (!isStr(e?.old_string) || !isStr(e?.new_string) || !text.includes(e.old_string)) return null
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string)
  }
  return text
}

// Only the lines the edit introduces, so a line already in the file is not
// charged to it.
export function proposedLines(ti, current) {
  if (isStr(ti.new_source)) return ti.new_source.split('\n')
  if (isStr(ti.content)) return fresh(current ?? '', ti.content)
  const edits = editsOf(ti)
  return edits ? edits.flatMap((e) => fresh(String(e?.old_string ?? ''), String(e?.new_string ?? ''))) : null
}
