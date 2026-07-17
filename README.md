<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="omit: Omit needless code." width="480">
  </picture>
</p>

# omit

**Omit needless code.**

An editorial discipline for AI coding agents. Named after Strunk & White's Rule 17: *"Omit needless words"*: applied to the way agents write software: they overwrite (bloat) and they overclaim (hallucinated shortcuts). `omit` fixes both.

> Draft less. Cite everything. Cut last.

## The problem

AI agents are prolific authors and terrible editors. Left alone they add abstractions nobody asked for, pull in dependencies for three lines of logic, and: when told to "keep it simple": confidently reach for stdlib APIs that don't exist. Minimalism-only rulesets fix the bloat and make the overclaiming *worse*: the pressure to write less rewards inventing shortcuts.

## The system

`omit` turns the agent from author into editor. Four parts:

| Part | What it does |
|---|---|
| **The Seven Omissions** | Before writing anything, try seven ways to *not* write it: omit the feature, the new code, the custom, the script, the dependency, the ceremony: stopping at the first omission that holds. What survives editing, ships. |
| **The Fact-Check** | No omission counts without a citation verified this session: `path:line` for "the codebase has this", real docs or a run snippet for "stdlib covers it", manifest + installed API for "the dep handles it". A hallucinated shortcut is a fabricated quote. |
| **The Final Draft** | Working code is a first draft. After tests go green, one ruthless edit of the agent's own diff: then a net report: files, ±lines, new deps (target: 0). Done means final draft, not green tests. |
| **Load-Bearing Lines** | Editing cuts fat, not walls. Validation, error handling, security, accessibility, concurrency correctness, and explicit requests are never cut: and adding them is announced, never smuggled or skipped. |

Deliberate omissions go on the record as footnotes in the code:

```js
// omitted: retries: single caller tolerates failure; add backoff if this goes multi-tenant
```

## Enforcement: asked for vs. made to

Every other skill in this genre is words the agent can ignore under context pressure. omit ships mechanisms that run *outside* the model:

| Mechanism | What it does |
|---|---|
| **Dep sentinel** (hook) | A new dependency hits a manifest with no receipt in `.omit/receipts.jsonl` → the edit is objected to on the spot. Cite why omissions 2-5 failed, or revert. |
| **Hazard sentinel** (hook) | Hardcoded API keys/secrets and injection-prone patterns (string-built SQL, `eval`, shell concatenation, `innerHTML`, unsafe deserialization) are blocked the moment they land in a file. Secrets have no override; injection lines need a reviewed `omit-allow: <reason>`. |
| **Lint sentinel** (hook) | omit ships no lint rules. It detects the linter the repo already configured (eslint, biome, ruff, flake8) and runs it on every edited file, so the agent hears objections immediately instead of at CI time. |
| **Final Draft gate** (hook) | The session cannot end with an edited tree and no `.omit/final-draft.md` net report. The deletion pass is a gate, not a suggestion. |
| **Receipts ledger** | Every Fact-Check citation is appended to `.omit/receipts.jsonl`: an auditable trail of the agent's claims your reviewers can actually read. |

Hooks install automatically with the Claude Code plugin. Escape hatch for humans: `OMIT_OFF=1`.

## Any provider, same gates

The enforcement logic lives in a zero-dependency CLI, not in any one vendor's hook system: Claude Code's hooks are just thin adapters over it. For Cursor, Codex, Copilot, or anything else, enforce at the two chokepoints every agent passes through:

```
npx @sriinnu/omit hook install   # git pre-commit: audits the staged diff,
                                 # fails on secrets, injections, uncited deps
npx @sriinnu/omit audit          # net diff, new deps, hazards, omit score
npx @sriinnu/omit check <files>  # hazard-scan specific files (wire into any hook system)
npx @sriinnu/omit lint [files]   # run the repo's OWN linter on changed files
npx @sriinnu/omit gate           # the pre-commit check, callable from anywhere
```

And server-side, the GitHub Action comments the verdict on every PR regardless of what wrote the code:

```yaml
# .github/workflows/omit.yml
on: pull_request
permissions: { pull-requests: write }
jobs:
  omit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: sriinnu/omit@main
```

```
### omit verdict
- net: +61 −204 lines across 4 files
- new deps: 0 ✅
- hazards: 0 ✅
- footnotes: 3 recorded · load-bearing: 1 marked
- omit score: 91/100 🟢
```

## The referee (experimental)

`bench/` is METHODOLOGY.md made runnable: paired agentic runs of the same tasks under baseline, omit, or **any competing skill**, metrics computed from the actual git diffs, all transcripts kept. The category argues about self-reported numbers; omit ships the measuring instrument. See `bench/README.md`.

## Modes

| Mode | Behavior |
|---|---|
| `margin` | Build as asked; note in the margin what could have been omitted |
| `redline` | **Default.** Full enforcement: Seven Omissions, Fact-Check, Final Draft |
| `rewrite` | Also question the assignment itself before building |
| `off` | Disabled until re-invoked |

Say `omit redline` (or any mode) in chat, or use `/omit <mode>` where slash commands are supported.

## Install

**Claude Code (plugin marketplace)**: one command pair, gets you the skill plus `/omit` and `/omit-edit`:

```
/plugin marketplace add sriinnu/omit
/plugin install omit@omit
```

**npm / npx**: drops the right rule file into the current repo (never overwrites existing files):

```
npx @sriinnu/omit init            # AGENTS.md (default)
npx @sriinnu/omit init claude     # .claude/skills/omit/SKILL.md
npx @sriinnu/omit init cursor     # .cursor/rules/omit.mdc
npx @sriinnu/omit init cline      # .clinerules/omit.md
npx @sriinnu/omit init windsurf   # .windsurf/rules/omit.md
npx @sriinnu/omit init all        # everything above
npx @sriinnu/omit hook install    # git pre-commit gate (works with ANY agent)
```

**Claude Code (manual)**: copy the skill into your project or user skills directory:

```
skills/omit/SKILL.md  →  .claude/skills/omit/SKILL.md      (project)
                         ~/.claude/skills/omit/SKILL.md    (all projects)
```

**Codex / Takumi / any AGENTS.md-aware agent**: copy `AGENTS.md` into your repo root (or append to an existing one), or `npx @sriinnu/omit init codex`.

**GitHub Copilot**: copy `.github/copilot-instructions.md` into your repo, or `npx @sriinnu/omit init copilot`.

**Cursor**: copy `.cursor/rules/omit.mdc` into your repo.

**Cline**: copy `.clinerules/omit.md` into your repo.

**Windsurf**: copy `.windsurf/rules/omit.md` into your repo.

**Anything else**: paste the contents of `AGENTS.md` into the agent's custom-instructions/rules mechanism. It's plain markdown; there is nothing to build.

```
// omitted: an MCP server: MCP exposes tools and data; omit is a behavioral
// discipline, and rule files + skills already deliver it. Add one only if
// omit ever grows verifiable tooling (e.g., a standalone diff auditor).
```

## Commands (Claude Code)

- `/omit [margin|redline|rewrite|off]`: switch or show the current mode
- `/omit-edit`: run an editor's pass over the current diff: flag bloat, uncited claims, missing footnotes, and cut opportunities

## Benchmarks

None yet: and we won't publish numbers we can't hand you the harness for. `benchmarks/METHODOLOGY.md` defines the measurement we consider honest (paired tasks, agentic baseline, net LOC / new deps / defect rate / load-bearing violations, full transcripts). Reproducible runs are the most welcome PR this repo can receive.

## Prior art

The minimalism-pressure idea was popularized by [ponytail](https://github.com/DietrichGebert/ponytail), which deserves its stars. `omit` differs where it matters: shortcuts require citations, the diff is edited *after* it works, safety lines are enumerated and never cut, and what's left out is footnoted instead of silent.

## License

MIT
