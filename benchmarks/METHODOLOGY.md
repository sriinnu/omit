# Benchmark methodology

No numbers are published in this repo until they come from a harness anyone can rerun. This file defines what we consider an honest measurement; reproducible runs are the most welcome PR this repo can receive.

## Design

**Paired agentic runs.** Each task runs twice in a real agent session (not single-shot prompting) against the same repo state: once with no rules loaded (baseline), once with `omit` in `redline` mode. Same model, same version, same temperature settings, same task wording.

**Task suite.** ≥12 tasks across at least two real codebases (one backend, one frontend), mixing feature work, bug fixes, and refactors. Tasks must be real enough to have a test suite that can fail.

## Metrics (per task, baseline vs. omit)

| Metric | How measured |
|---|---|
| Net LOC | `git diff --shortstat` after the session ends |
| New dependencies | Manifest diff (target under omit: 0) |
| Defect rate | Held-out test suite the agent never sees, run after the session |
| Fabricated-API rate | Count of calls to stdlib/dep APIs that don't exist in the installed versions (caught by compile/lint/run) |
| Load-bearing violations | Human review: validation/error-handling/security removed or skipped relative to task requirements |
| Wall time & cost | Session duration and token spend, from the agent's own accounting |

## Reporting rules

- Publish full transcripts of every run, both arms, no cherry-picking. Failed runs count.
- Report medians and ranges, not just means; 12 tasks is small.
- Less code is not the win condition. A result where omit writes less code but fails more held-out tests is a **negative** result and gets published as one.

## Why this strictness

The genre this project lives in is famous for self-reported "X% less code!" claims measured on single-shot toy tasks. The entire premise of `omit` is that claims need receipts. That applies to us first.
