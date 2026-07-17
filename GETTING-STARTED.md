# Getting started with omit

omit works two ways, and the best setups use both:

1. **Rule file / skill**: your agent adopts the editorial discipline (Seven Omissions, Fact-Check, Final Draft, Load-Bearing Lines).
2. **Enforcement**: hooks, a git pre-commit gate, and a PR bot that block secrets, injection patterns, uncited dependencies, and lint failures no matter what wrote the code.

## The one-time setup

```
npm install -g github:sriinnu/omit
```

That gives you a global `omit` command everywhere: `omit init cursor`, `omit audit`, `omit gate`. Prefer not to install? One-off runs work too: `npx github:sriinnu/omit init cursor`. Every `npx @sriinnu/omit ...` below can be written as plain `omit ...` once globally installed.

## Claude Code (full experience: discipline + live hooks)

```
/plugin marketplace add sriinnu/omit
/plugin install omit@omit
```

Restart the session. You now have the skill, the `/omit` and `/omit-edit` commands, and five live hooks: the command sentinel (blocks `rm -rf ~` class disasters before they run), the dep sentinel, the hazard sentinel (secrets and injections), the lint sentinel, and the Final Draft gate.

Try it: ask for "add lodash to dedupe an array" and watch the agent get objected into `[...new Set(arr)]`. Escape hatch when you need it: set `OMIT_OFF=1`.

Prefer no plugin? Copy `skills/omit/SKILL.md` to `.claude/skills/omit/SKILL.md` (project) or `~/.claude/skills/omit/SKILL.md` (everywhere), or run `npx @sriinnu/omit init claude`.

## Cursor

```
npx @sriinnu/omit init cursor
```

Drops `.cursor/rules/omit.mdc` with `alwaysApply: true`; every chat and composer run follows the discipline. Add `hook install` (below) for hard enforcement.

## Codex CLI

```
npx @sriinnu/omit init codex
```

Drops `AGENTS.md`, which Codex reads natively. If the repo already has an `AGENTS.md`, the command skips it; append the contents of ours instead.

## Takumi

```
npx @sriinnu/omit init takumi
```

Same `AGENTS.md` convention as Codex.

## GitHub Copilot

```
npx @sriinnu/omit init copilot
```

Drops `.github/copilot-instructions.md`; Copilot Chat and the coding agent pick it up automatically.

## Cline

```
npx @sriinnu/omit init cline
```

Drops `.clinerules/omit.md`.

## Windsurf

```
npx @sriinnu/omit init windsurf
```

Drops `.windsurf/rules/omit.md`.

## Gemini CLI and anything else

```
npx @sriinnu/omit init agents
```

Drops `AGENTS.md`. If your agent does not read `AGENTS.md` on its own, paste the file's contents into its custom-instructions or rules setting (for Gemini CLI: `GEMINI.md`). It is plain markdown; nothing to build.

## Everything at once

```
npx @sriinnu/omit init all
```

Writes every rule file above. Existing files are never overwritten.

## Enforcement for ANY agent (do this in every repo)

Rule files are advisory outside Claude Code. These two are not:

```
npx @sriinnu/omit hook install
```

Adds the omit gate to `.git/hooks/pre-commit`: commits containing secrets, injection-prone lines, uncited new dependencies, or lint failures are refused, whether Claude, Cursor, Copilot, or a human wrote them.

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

Comments the verdict (net lines, new deps, hazards, lint, omit score) on every PR.

## CLI cheat sheet

```
npx @sriinnu/omit audit            # verdict on uncommitted changes
npx @sriinnu/omit audit --base origin/main --markdown
npx @sriinnu/omit check src/x.js   # hazard-scan specific files
npx @sriinnu/omit lint             # run the repo's own linter on changed files
npx @sriinnu/omit gate             # the pre-commit check, manually
```

Draft less. Cite everything. Cut last.
