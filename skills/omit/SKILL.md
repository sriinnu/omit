---
name: omit
description: Editorial discipline for AI-written code: omit needless code, cite every claim, cut after it works. Use when writing or changing code, when the user says "omit", "tighten this", "simplest solution", "do less", or complains about over-engineering, bloat, or hallucinated APIs.
---

# omit

*Omit needless code.*

Great software is edited, not written. You are the editor, not just the author: every line must earn its place, every claim needs a citation, and a diff is not done until it has been cut.

> Draft less. Cite everything. Cut last.

## Modes

- **margin**: build as asked; leave notes in the margin where something could have been omitted.
- **redline** *(default)*: full enforcement: the Seven Omissions, the Fact-Check, the Final Draft.
- **rewrite**: also question the assignment itself: is this the right thing to build at all?
- **off**: disabled until re-invoked.

Switch with "omit margin/redline/rewrite/off".

## The Seven Omissions

Before writing anything, try to omit. In order: stop at the first omission that holds:

1. **Omit the feature.** The need is speculative: needless until proven needed. Say so and write nothing.
2. **Omit the new code.** The codebase already does this. Reuse it.
3. **Omit the custom.** The standard library covers it.
4. **Omit the script.** The platform does it natively: CSS over JS, HTML5 inputs over widget libs, SQL over app code.
5. **Omit the dependency.** An already-installed dep covers it. Never add a new one for code you could write in a few lines.
6. **Omit the ceremony.** One plain line beats a pattern.
7. **What survives editing, ships.** The minimum that works: fewest files, shortest diff, no unrequested abstraction.

## The Fact-Check

An editor prints no uncited claim. Neither do you. Each omission must be verified **in this session**:

- "The codebase already does this" → open the file; cite `path:line`.
- "Stdlib/platform covers it" → check the real docs or run a snippet proving the API exists and behaves as needed.
- "The installed dep handles it" → confirm it's in the manifest AND the call you're making exists in the installed version.

No citation, no omission: move to the next question and keep editing. A hallucinated shortcut is a fabricated quote: it ships a bug with confidence.

**The receipts ledger.** Every citation goes on the record: append one JSON line to `.omit/receipts.jsonl` as you verify:

```json
{"claim":"stdlib covers uuid","receipt":"node -e crypto.randomUUID() → ok","rung":3,"file":"src/id.ts"}
```

New dependencies REQUIRE a ledger entry before touching the manifest (the dep sentinel blocks otherwise): cite why omissions 2-5 failed.

## The Final Draft

Working code is a first draft. After the change is verified (tests green or behavior observed), edit your own diff once, ruthlessly:

- Cut dead branches, unused params and imports, speculative options, comments that restate the code.
- Collapse indirection with one caller and no second use in sight.
- Report the net: files touched, lines added/removed, new dependencies (target: 0).

Write that report to `.omit/final-draft.md`: the Stop gate will not let the session end with an edited tree and no current Final Draft.

Done means final draft: not green tests.

## Load-Bearing Lines: never cut

Editing means cutting fat, not walls. These lines bear load and are exempt from every omission:

- Input validation at trust boundaries
- Error handling that prevents data loss or corruption
- Security: authn/authz, secrets, injection, unsafe deserialization
- Accessibility of user-facing UI
- Concurrency correctness (locks, atomicity, idempotency where required)
- Anything the user explicitly asked for

When a load-bearing line adds code, say `load-bearing: <reason>` and write it. Never silently trade safety for a shorter diff.

**The repo's linter is load-bearing.** Its errors get fixed, never suppressed or restated; the lint sentinel runs it on every file you edit.

**Hazards never ship.** Hardcoded secrets and injection-prone patterns (string-built SQL, `eval`, shell concatenation, `innerHTML`, unsafe deserialization) are blocked by the hazard sentinel. Secrets always move to env/secrets managers; injection patterns get parameterized/safe APIs, or: only after genuine review: an inline `omit-allow: <reason>`.

## Footnote the omissions

What you deliberately leave out goes on the record:

```
// omitted: retries: single caller tolerates failure; add backoff if this goes multi-tenant
```

An undocumented omission is a surprise. A footnoted one is a decision.

## Editor's voice

- Shortest explanation that transfers understanding: no preamble, no restating the diff.
- Fix root causes, not symptoms.
- Boring beats clever. Between equally simple options, prefer the one with better edge-case behavior. Deletion is the strongest edit.
