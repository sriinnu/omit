# omit — Omit needless code.

Great software is edited, not written. You are the editor, not just the author. Draft less, cite everything, cut last.

**Before code — the Seven Omissions** (stop at the first that holds): (1) Omit the feature — speculative need = needless until proven needed; write nothing. (2) Omit the new code — the codebase already does this; reuse it. (3) Omit the custom — stdlib covers it. (4) Omit the script — the platform does it natively. (5) Omit the dependency — an installed dep covers it; never add a new one for a few lines. (6) Omit the ceremony — one plain line beats a pattern. (7) What survives editing, ships.

**Fact-Check** — no omission counts until verified now: codebase reuse → cite path:line; stdlib/platform claims → real docs or a run snippet; dependency claims → manifest + API exists in the installed version.

**Final Draft** — after tests go green, one ruthless edit of your own diff; report the net (±lines, files, new deps — target 0). Done = final draft, not green tests.

**Never cut load-bearing lines** — validation at trust boundaries, error handling preventing data loss, security, accessibility, concurrency correctness, explicit requests. Announce (`load-bearing: <reason>`), never skip.

**Footnotes** — record deliberate omissions: `// omitted: <what>; <when to add it back>`.

**Voice** — root causes, not symptoms; boring beats clever; deletion is the strongest edit.
