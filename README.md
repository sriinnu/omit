# omit

**Omit needless code.**

An editorial discipline for AI coding agents. Named after Strunk & White's Rule 17 — *"Omit needless words"* — applied to the way agents write software: they overwrite (bloat) and they overclaim (hallucinated shortcuts). `omit` fixes both.

> Draft less. Cite everything. Cut last.

## The problem

AI agents are prolific authors and terrible editors. Left alone they add abstractions nobody asked for, pull in dependencies for three lines of logic, and — when told to "keep it simple" — confidently reach for stdlib APIs that don't exist. Minimalism-only rulesets fix the bloat and make the overclaiming *worse*: the pressure to write less rewards inventing shortcuts.

## The system

`omit` turns the agent from author into editor. Four parts:

| Part | What it does |
|---|---|
| **The Seven Omissions** | Before writing anything, try seven ways to *not* write it — omit the feature, the new code, the custom, the script, the dependency, the ceremony — stopping at the first omission that holds. What survives editing, ships. |
| **The Fact-Check** | No omission counts without a citation verified this session: `path:line` for "the codebase has this", real docs or a run snippet for "stdlib covers it", manifest + installed API for "the dep handles it". A hallucinated shortcut is a fabricated quote. |
| **The Final Draft** | Working code is a first draft. After tests go green, one ruthless edit of the agent's own diff — then a net report: files, ±lines, new deps (target: 0). Done means final draft, not green tests. |
| **Load-Bearing Lines** | Editing cuts fat, not walls. Validation, error handling, security, accessibility, concurrency correctness, and explicit requests are never cut — and adding them is announced, never smuggled or skipped. |

Deliberate omissions go on the record as footnotes in the code:

```js
// omitted: retries — single caller tolerates failure; add backoff if this goes multi-tenant
```

## Modes

| Mode | Behavior |
|---|---|
| `margin` | Build as asked; note in the margin what could have been omitted |
| `redline` | **Default.** Full enforcement — Seven Omissions, Fact-Check, Final Draft |
| `rewrite` | Also question the assignment itself before building |
| `off` | Disabled until re-invoked |

Say `omit redline` (or any mode) in chat, or use `/omit <mode>` where slash commands are supported.

## Install

**Claude Code (plugin marketplace)** — one command pair, gets you the skill plus `/omit` and `/omit-edit`:

```
/plugin marketplace add sriinnu/omit
/plugin install omit@omit
```

**npm / npx** — drops the right rule file into the current repo (never overwrites existing files):

```
npx @sriinnu/omit            # AGENTS.md (default)
npx @sriinnu/omit claude     # .claude/skills/omit/SKILL.md
npx @sriinnu/omit cursor     # .cursor/rules/omit.mdc
npx @sriinnu/omit cline      # .clinerules/omit.md
npx @sriinnu/omit windsurf   # .windsurf/rules/omit.md
npx @sriinnu/omit all        # everything above
```

**Claude Code (manual)** — copy the skill into your project or user skills directory:

```
skills/omit/SKILL.md  →  .claude/skills/omit/SKILL.md      (project)
                         ~/.claude/skills/omit/SKILL.md    (all projects)
```

**Codex / any AGENTS.md-aware agent** — copy `AGENTS.md` into your repo root (or append to an existing one).

**Cursor** — copy `.cursor/rules/omit.mdc` into your repo.

**Cline** — copy `.clinerules/omit.md` into your repo.

**Windsurf** — copy `.windsurf/rules/omit.md` into your repo.

**Anything else** — paste the contents of `AGENTS.md` into the agent's custom-instructions/rules mechanism. It's plain markdown; there is nothing to build.

```
// omitted: an MCP server — MCP exposes tools and data; omit is a behavioral
// discipline, and rule files + skills already deliver it. Add one only if
// omit ever grows verifiable tooling (e.g., a standalone diff auditor).
```

## Commands (Claude Code)

- `/omit [margin|redline|rewrite|off]` — switch or show the current mode
- `/omit-edit` — run an editor's pass over the current diff: flag bloat, uncited claims, missing footnotes, and cut opportunities

## Benchmarks

None yet — and we won't publish numbers we can't hand you the harness for. `benchmarks/METHODOLOGY.md` defines the measurement we consider honest (paired tasks, agentic baseline, net LOC / new deps / defect rate / load-bearing violations, full transcripts). Reproducible runs are the most welcome PR this repo can receive.

## Prior art

The minimalism-pressure idea was popularized by [ponytail](https://github.com/DietrichGebert/ponytail), which deserves its stars. `omit` differs where it matters: shortcuts require citations, the diff is edited *after* it works, safety lines are enumerated and never cut, and what's left out is footnoted instead of silent.

## License

MIT
