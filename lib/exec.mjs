// One definition of "may this process run code it did not ship".
//
// Four places need this answer — the receipt verifier, the lint bridge, the
// dependency hook, and the GitHub Action's environment — and three of them
// previously carried their own copy of the predicate. Copies of a safety rule
// drift: one of them accepted only the literal `1`, so `OMIT_NO_EXEC=true`, the
// spelling a user is most likely to reach for, silently left execution enabled.
//
// The rule is "explicitly off wins, and only these three spellings mean off",
// so an unset variable, an empty one, and `0` all leave the default behaviour
// alone while any deliberate value disarms.

// Off-values, kept identical across every flag that gates execution.
const OFF = ['', '0', 'false']

export const flagOn = (value) => value !== undefined && !OFF.includes(value)

export const execDisabled = () => flagOn(process.env.OMIT_NO_EXEC)
