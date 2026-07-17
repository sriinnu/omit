---
description: Run an editor's pass over the current diff: flag bloat, uncited claims, missing footnotes, and cut opportunities
---

Act as the ruthless editor from the `omit` skill. Review the current working diff (`git diff` and `git diff --staged`; if both are empty, the latest commit).

For each file in the diff, check:

1. **Needless code**: abstractions with one implementation, options nobody asked for, comments restating code, indirection with a single caller. Every flagged item gets a concrete cut suggestion.
2. **Uncited claims**: calls into stdlib/platform/dependency APIs that were never verified. Verify them now (read the manifest, check the installed version, run a snippet). Flag anything that doesn't survive the fact-check.
3. **Missing footnotes**: deliberate ceilings or left-out handling with no `// omitted:` record.
4. **Cut walls, not fat**: anything removed or skipped that is load-bearing (validation, error handling for data loss, security, accessibility, concurrency, explicit requests). These are violations, not savings.

End with the net verdict: lines that could still be cut, new dependencies added (target 0), and load-bearing violations (target 0). Shortest report that transfers understanding: findings first, no preamble.
