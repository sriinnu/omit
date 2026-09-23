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
| **The Fact-Check** | No omission counts without a citation **the tool can re-check itself**: `file:line:symbol` for "the codebase has this", an executable snippet for "stdlib covers it", a declared dep + snippet for "the dep handles it". A citation only its author can read is a self-report, and a hallucinated shortcut is a fabricated citation. |
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
| **Command sentinel** (hook) | Inspects every shell command BEFORE it runs and blocks the classic agent disasters: `rm -rf ~`, recursive deletes of system/drive roots, deletes through unset variables (`rm -rf $OUT/*` with `$OUT` empty), `dd` to block devices, `mkfs`, fork bombs. The user's machine is load-bearing. Waiving one takes a trailing comment carrying a real reason — `# omit-allow: <reason>`. The bare token, a token inside a string literal, and a reason-less marker are ignored. |
| **Dep sentinel** (hook) | A new dependency hits a manifest with no *verified* receipt in `.omit/receipts.jsonl` → the edit is objected to on the spot. The receipt has to name the omissions that were tried, and each one is re-checked: if an omission actually applies, the receipt is refuted and the dependency is refused. |
| **Hazard sentinel** (hook) | Hardcoded API keys/secrets and injection-prone patterns (string-built SQL, `eval`, shell concatenation, `innerHTML`, unsafe deserialization) are blocked the moment they land in a file. **Secrets have no override** — the secret rules run before any marker is consulted, so no `omit-allow:` waives one. Injection lines take a trailing comment with a real reason, and only that form. |
| **Leak sentinel** (hook) | Blocks shell commands that print an *existing* secret's raw value to stdout before they run, or a live key typed straight into the command line: macOS Keychain, Linux `secret-tool`/`pass`/`gpg -d`, 1Password/Vault/AWS/GCP/Azure/kubectl secret CLIs, bare `env`/`printenv`, `env \| grep`-ing a KEY/TOKEN/SECRET/connection-string var, or `cat`-ing a `.env`/`credentials`/`*.pem`/`id_rsa` file. Redirecting to a real file or piping into a non-printing sink (clipboard, `--password-stdin`) is recognized as safe — the goal is keeping secrets out of the transcript, not off disk. Adversarially reviewed (3 lenses, every finding re-verified by execution, not inspection) before shipping — one known gap stays undetected on purpose rather than chasing a fragile fix: a `for`/`do`/`done > file` loop's trailing redirect isn't attributed back to the loop body. The agent's own transcript is not a safe place for a real key. |
| **Lint sentinel** (hook) | omit ships no lint rules. It detects the linter the repo already configured (eslint, biome, ruff, flake8) and runs it on every edited file, so the agent hears objections immediately instead of at CI time. A linter that is configured but cannot be run — no `node_modules`, nothing on PATH — is reported as *not run* with the reason, never as a pass; "no linter configured" is now reserved for a repo that genuinely has none. |
| **Final Draft gate** (hook) | The session cannot end with an edited tree and no current `.omit/final-draft.md` net report — and the report is read, not just stat'd. Its files/lines/deps counts are cross-checked against the actual diff, so a stub or a stale draft does not pass. The deletion pass is a gate, not a suggestion. |
| **Receipts ledger** | Every Fact-Check citation is appended to `.omit/receipts.jsonl` as a claim *plus the evidence that settles it*, and `omit verify` re-checks the lot. Run it on a PR: "17/17 claims survived" is a number a reviewer can act on, and "3 refuted" names exactly which shortcuts were invented. |

Hooks install automatically with the Claude Code plugin. Codex CLI has its own hooks system in the same shape (`PreToolUse` fires with `tool_input.command` for Bash, exit 2 blocks) — run `npx @sriinnu/omit hook install codex` to write `.codex/hooks.json`. The command and leak sentinels are verified against Codex's documented schema and payload shape (not yet a live Codex session firing them end-to-end); the file-based sentinels (dep/hazard/lint) and the Final Draft gate are wired too but best-effort, since Codex's `apply_patch` input shape for those isn't verified. Escape hatch for humans: `OMIT_OFF=1`.

## What this does not catch

A table of mechanisms invites you to read it as a guarantee. It isn't one, so here is the rest of it. Every item below is a known, reproduced limit, not a hypothetical.

- **Writes whose path cannot be read out of the command reach no file sentinel.** `python -c "open('f','w').write(...)"`, `curl -o f`, `node -e fs.writeFileSync`. A literal secret in such a command is still caught by the command-text scan; its *injection* patterns are not. The same goes for a file rewritten through a tool no sentinel is wired to.
- **`omit gate` is a git hook.** `git commit --no-verify` skips it, and `core.hooksPath` shadows it entirely — `omit audit` and `omit gate` both report that in the verdict, and `omit hook install` writes to whichever directory git actually runs hooks from, but nothing can stop you bypassing your own pre-commit hook.
- **The dependency allowlist is short.** `setup.py`, `build.gradle`, `Package.swift` and `*.csproj` are dependency-shaped and unparsed. They are now *reported* (`unparsed deps: …`) rather than counted as zero, and a changed one suppresses the `✅` on the deps row — but the gate does not fail on them, because a `setup.py` in a repo is not evidence of anything.
- **The lint sentinel runs your linter in your session**, which executes your lint config — the same trust as running `npm run lint` yourself. In the GitHub Action it is gated: with the default `exec: false`, CI does not run the linter at all, and the verdict says *not run* rather than claiming a pass.
- **Receipt evidence is bound to its claim textually.** A `run` snippet must name what it exercises and the argv must mention it, which closes snippets that exit on demand (`["true"]`, `["false"]`). It does not catch a snippet that names a symbol without calling it. Proving that would mean the verifier writing the snippet, and then it is testing the verifier.
- **`omit`'s own directory is exempt** from the hazard scan, because the ledger holds evidence strings by construction. Its execution risk is what `OMIT_HOOK_EXEC` gates.
- **The Action does not run a PR's receipts** unless you set `with: { exec: true }`. A PR's `run` snippets are untrusted code, so the default is not to execute them.

`// omitted: a mechanism for the first item above` would be a shell parser, and a wrong shell parser is worse than none. It is left out on purpose.

## Receipts: the claim and the evidence, in one line

Minimalism is a taste, and taste has no receipt. The failure mode underneath it does: the agent says *"the codebase already does this"* or *"stdlib covers it"*, and nobody checks. Every rule file in this genre **tells** the agent not to lie. `omit` checks.

Each claim lands in `.omit/receipts.jsonl` with the evidence that settles it:

```json
{"claim":"reuse","rung":2,"file":"src/util.ts","line":42,"symbol":"parseRange"}
{"claim":"stdlib","rung":3,"api":"crypto.randomUUID","run":["node","-e","crypto.randomUUID()"]}
{"claim":"installed-dep","rung":5,"dep":"zod","run":["node","-e","require('zod').object"]}
{"claim":"new-dep","rung":7,"dep":"left-pad","tried":[{"rung":2,"absent":"padTo"}]}
```

```
$ npx @sriinnu/omit verify
✅ line   1  verified      reuse
⛔ line   2  failed        new-dep
        [new-dep] tried[0] (rung 2) actually HOLDS: padTo is present at src/util.ts — so the omission applies and this dep is not needed

1/2 claims survived re-checking · 1 refuted · 0 unverifiable
```

That second one is the whole idea. A `new-dep` receipt exists to say *"I tried the earlier omissions and none of them held"* — so it cites the symbol it looked for, `omit` searches the tree for itself, and a symbol that **is** there refutes the agent's own conclusion. When the author supplies the question instead of the evidence, citing your way past an omission you never tried stops being possible.

Two bindings make that hold, and neither is decorative:

- **`run` must name what it exercises** (`api`, or the dependency), and the argv must mention it. Exit status alone proves nothing: `["true"]` exits 0 and `["false"]` exits 1 while testing neither the standard library nor anything else. A snippet that exits on demand is not evidence.
- **A `tried` entry cites a search, not a location.** Naming a file that merely doesn't exist proves nothing — and it used to be the cheapest possible way to fake "I tried reuse", because the check only asked whether it failed.

`run` is an argv array, never a shell string: nothing expands, nothing hides in an argument. `.omit/receipts.jsonl` is executable in the same sense a Makefile is — read it in a PR the way you'd read one. `OMIT_NO_EXEC=1` downgrades those checks to "unverifiable" instead of executing them, and the dependency hook does not execute them at all unless you set `OMIT_HOOK_EXEC=1`: a *Write* of the ledger would otherwise run code as you, with no approval prompt.

**Upgrading from 0.3.x:** the shapes above are the 0.4.0 schema. A receipt written before it — a prose `receipt` string, or a `tried` entry citing a file — reads as `unverifiable`, which `omit verify` names individually. They are not silently accepted, and they are not silently dropped.

## Any provider, same gates

The enforcement logic lives in a zero-dependency CLI, not in any one vendor's hook system: Claude Code's and Codex's hooks are both just thin adapters over it. For Cursor, Copilot, or anything else, enforce at the two chokepoints every agent passes through:

```
npx @sriinnu/omit hook install   # git pre-commit: audits the staged diff,
                                 # fails on secrets, injections, uncited deps
npx @sriinnu/omit audit          # net diff (untracked files included), new deps, hazards
npx @sriinnu/omit check <files>  # hazard-scan specific files (wire into any hook system)
npx @sriinnu/omit lint [files]   # run the repo's OWN linter on changed files
npx @sriinnu/omit verify         # re-check every claim in .omit/receipts.jsonl
npx @sriinnu/omit guard "<cmd>"  # is this shell command a disaster? (wire into any hook system)
npx @sriinnu/omit leak "<cmd>"   # would this command print a real secret to stdout?
npx @sriinnu/omit gate           # the pre-commit check, callable from anywhere
npx @sriinnu/omit hook install codex  # write .codex/hooks.json — live sentinels inside Codex CLI
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
        # with: { exec: true }   # execute receipts' `run` snippets to verify them
                                 # fully. Off by default: a PR's receipts are
                                 # untrusted code, and this runs on pull requests.
```

```
### omit verdict
- net: +61 −204 lines across 4 files
- new deps: 0 ✅
- hazards: 0 ✅
- footnotes: 3 recorded · load-bearing: 1 marked
- receipts: 17/17 verified
- lint: eslint ✅
```

```
// omitted: a composite "omit score": any weight vector over these counts is
// invented, and footnotes could raise it by adding lines. The counts above are
// the receipts; a single number would just be another uncited claim.
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

New here? **[GETTING-STARTED.md](GETTING-STARTED.md)** has a copy-paste setup for every agent.

**Claude Code (plugin marketplace)**: one command pair, gets you the skill plus `/omit` and `/omit-edit`:

```
/plugin marketplace add sriinnu/omit
/plugin install omit@omit
```

**Any SKILL.md-aware agent** (Claude Code, Codex, Cursor, and others, via [skills.sh](https://skills.sh)):

```
npx skills add sriinnu/omit
```

**Global command**: install once from GitHub, use everywhere:

```
npm install -g github:sriinnu/omit
omit init cursor        # or: omit audit / omit gate / omit hook install
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

## Releasing

One command, three destinations (npm, GitHub, Homebrew):

    npm run release -- patch    # or minor / major

`scripts/release.mjs` runs the tests (via `preversion`), bumps and tags with
`npm version` (signed, per repo policy), and pushes — the tag triggers
`publish.yml`, which publishes to npm **with a provenance attestation**. It
then cuts the GitHub release with generated notes, waits for the registry to
serve the version, and updates the `omit` formula in
[`sriinnu/homebrew-tap`](https://github.com/sriinnu/homebrew-tap). A failed
step aborts the release, in order.

Never `npm publish` by hand: a local publish cannot attach provenance, and
npm will not let the same version be republished to add one later. If the CI
publish fails, fix CI — don't work around it locally.

If the `NPM_TOKEN` secret ever goes stale, put the new token in `~/.npmrc`
and run `npm run token:sync` — it verifies the token against the registry
before pushing, so a dead token never reaches CI.

## Prior art

The minimalism-pressure idea was popularized by [ponytail](https://github.com/DietrichGebert/ponytail), which deserves its stars. `omit` differs where it matters: shortcuts require citations, the diff is edited *after* it works, safety lines are enumerated and never cut, and what's left out is footnoted instead of silent.

## License

MIT
