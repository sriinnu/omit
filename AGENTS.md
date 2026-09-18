# omit: Omit needless code.

Editorial rules for AI coding agents. Portable: copy this file (or its contents) into any agent's rule system (`AGENTS.md`, `.cursor/rules/`, `.clinerules/`, `.github/copilot-instructions.md`, `GEMINI.md`, …).

Great software is edited, not written. Every line must earn its place, every claim needs a citation, and a diff is not done until it has been cut.

> Draft less. Cite everything. Cut last.

## Before code: the Seven Omissions

Try to omit, in order: stop at the first omission that holds:

1. **Omit the feature.** Speculative need: needless until proven needed. Write nothing.
2. **Omit the new code.** The codebase already does this. Reuse it.
3. **Omit the custom.** The standard library covers it.
4. **Omit the script.** The platform does it natively (CSS over JS, HTML5 over widget libs, SQL over app code).
5. **Omit the dependency.** An installed dep covers it. Never add a new one for a few lines of code.
6. **Omit the ceremony.** One plain line beats a pattern.
7. **What survives editing, ships.** Minimum that works: fewest files, shortest diff, no unrequested abstraction.

## The Fact-Check

No omission counts until verified in this session — and verified means checkable by something other than you. Record each one in `.omit/receipts.jsonl`, one JSON object per line, naming its own evidence:

```
{"claim":"reuse","rung":2,"file":"src/x.ts","line":42,"symbol":"parseRange"}
{"claim":"stdlib","rung":3,"api":"crypto.randomUUID","run":["node","-e","crypto.randomUUID()"]}
{"claim":"installed-dep","rung":5,"dep":"zod","run":["node","-e","require('zod').object"]}
{"claim":"new-dep","rung":7,"dep":"left-pad","tried":[{"rung":2,"absent":"padTo"}]}
```

Evidence is bound to the claim: a snippet's exit status proves nothing on its own, so `run` must also name what it exercises and the argv must mention it. `run` is argv, never a shell string. A `tried` entry cites a symbol to search the tree for, not a location — citing a file that merely does not exist proves nothing. A `new-dep` receipt is the strongest claim: it asserts omissions 2-5 were tried and did not hold, so every `tried` entry is re-checked and must fail. `omit verify` re-checks the ledger; `omit gate` refuses a new dependency cited by anything less. No receipt, no omission.

## After code works: the Final Draft

One ruthless edit of your own diff: dead branches, unused params/imports, speculative options, comments restating code, single-caller indirection. Write the net report to `.omit/final-draft.md` in the shape the stop gate parses — `files touched: <n>`, `lines +<added> −<removed>`, `new dependencies: <n>` (untracked files count; `omit audit` prints exactly these). Done = final draft, not green tests.

## Load-Bearing Lines: never cut

Input validation at trust boundaries; error handling preventing data loss; security (authn/authz, secrets, injection, deserialization); accessibility; concurrency correctness; anything explicitly requested. Mark with `load-bearing: <reason>` and write it.

## Footnotes

Record deliberate omissions in code: `// omitted: <what>; <when to add it back>`.

## Voice

Root causes, not symptoms. Boring beats clever. Deletion is the strongest edit. Shortest explanation that transfers understanding.

## Modes

`margin` (advisory) · `redline` (default: full enforcement) · `rewrite` (also challenge the assignment) · `off`.
