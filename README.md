<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="omit: Omit needless code." width="480">
  </picture>
</p>

# omit

**Omit needless code.**

omit is an editorial discipline for AI coding agents, named for Strunk & White's Rule 17, *"Omit needless words"*. It asks agents to write less and cite every shortcut, and enforces that with hooks, a pre-commit gate and a CI check that run outside the model.

> Draft less. Cite everything. Cut last.

Agents add abstractions nobody asked for, pull in dependencies for three lines of logic, and, told to keep it simple, confidently reach for stdlib APIs that don't exist. Minimalism-only rulesets fix the bloat and make the overclaiming worse, because pressure to write less rewards inventing shortcuts.

A commit the gate refuses, in a repo that adopted omit (output copied from a real run):

```
$ git commit -m "pad strings"
omit verdict
────────────
net: +1 −1 lines across 1 file
new deps: 1: left-pad (1 without receipts ⚠)
hazards: 0 ✅
footnotes: 0 recorded · load-bearing: 0 marked
receipts: none recorded
lint: no linter configured

⛔ omit gate: new dep(s) without a verified receipt: left-pad.
   .omit/receipts.jsonl is not part of this commit — receipts are read from the index, so a ledger that is not being committed cites nothing.
Add one line to .omit/receipts.jsonl naming the dep and the omission you tried (each entry is re-checked, and must NOT hold):
  {"claim":"new-dep","rung":7,"dep":"left-pad","tried":[{"rung":2,"absent":"<symbol you searched for>"}]}
Run `omit verify` to check it before committing.
```

## Install

Needs Node 20 or newer.

```sh
npm install -g @sriinnu/omit    # published with provenance
```

Or, with Homebrew, `brew install sriinnu/tap/omit`.

Then, in each repo, install the pre-commit gate (it checks every commit, whatever agent wrote it):

```sh
omit hook install
```

Install globally for the gate. `npx @sriinnu/omit` works for anything else, but it costs about 3 seconds per commit and hangs offline. `omit hook install` writes `omit gate` into `.git/hooks/pre-commit` when `omit` is on your PATH, and an `npx -y` call pinned to the installed version otherwise.

Then give your agent the discipline and the live hooks. In Claude Code (skill, `/omit`, `/omit-edit` and every hook):

```
/plugin marketplace add sriinnu/omit
/plugin install omit@omit
```

In a shell, for any other agent:

```sh
npx skills add sriinnu/omit    # any SKILL.md-aware agent, via skills.sh
omit init cursor               # or another rule file: see "Other agents"
```

[GETTING-STARTED.md](GETTING-STARTED.md) has a copy-paste setup for each agent.

## What you get

| | Where | What |
|---|---|---|
| **Safety** | every repo, every mode | Destructive commands, secret leaks and hardcoded secrets, certificate-verification bypass, and tampering with omit's own hooks are blocked. The commit gate always blocks secrets and TLS bypass. |
| **Editorial** | repos that [adopted omit](#adopting-omit-in-a-repo) | Injection patterns, new dependencies without a verified receipt, refuted receipts, the repo's own linter, and the Final Draft gate. |

The editorial half is opt-in per repo because uncited-dependency and lint objections are an imposition on a codebase that never agreed to them. Secrets are not.

## Adopting omit in a repo

A repo has adopted omit when `.omit/` is tracked (in HEAD or the index, so the commit that adds it is already judged) or `git config omit.enforce true` is set. Elsewhere the gate skips the editorial checks and prints one line saying how to opt in.

`git config omit.enforce false` opts out even in an adopted repo. That is the user's call: the command sentinel blocks an agent from running it, and from running `git config omit.trusted …`. omit itself does not read `omit.trusted`; the block is there for setups that use it to decide which repos may run code at commit time.

### Modes

| Mode | Behavior |
|---|---|
| `margin` | Build as asked. Final Draft, receipt, lint and injection objections are reported, not enforced. |
| `redline` | **Default.** Full enforcement: Seven Omissions, Fact-Check, Final Draft. |
| `rewrite` | Redline, and question the assignment itself before building. |
| `off` | Editorial gates are quiet. |

Set the mode with `/omit <mode>` in Claude Code or `omit mode <mode>` in a shell. It lives in `.omit/mode` (or `OMIT_MODE`). The hooks enforce it, not the model, and the tamper sentinel stops an agent from writing it. A committed `.omit/mode` can quiet a repo's own editorial commit checks. It cannot touch the safety ones.

`OMIT_OFF=1` and `off` do different things:

- **`OMIT_OFF=1` in the harness's environment** silences every hook, safety sentinels included. Only the literal `1` counts.
- **`omit gate`** (the pre-commit hook and CI) treats `OMIT_OFF=1` as mode `off`: it skips the editorial checks and still blocks secrets and TLS bypass.

Placeholders AWS publishes in its own docs (the `…EXAMPLE` access key ID and its example secret key) are not leaks. Any other key is.

Injection patterns are not checked in docs (`*.md`, `*.mdx`, `*.rst`, `*.txt`, `docs/`), vendored and minified code (`vendor/`, `third_party/`, `*.min.js`, `*.min.css`) or lockfiles. Secrets and TLS bypass are still read there. `omit`'s own `.omit/` directory is exempt from the hazard scan, because the ledger holds evidence strings by construction. Running its snippets is what `OMIT_HOOK_EXEC` gates.

## The discipline

omit turns the agent from author into editor. The rule file and skill teach it; the sentinels below enforce it.

Four terms recur through this README.

- **Receipt:** one line in `.omit/receipts.jsonl` that records a claim ("the codebase already does this") with the evidence that settles it. omit re-checks it. See [Receipts](#receipts).
- **Rung:** the number of an omission in the Seven Omissions below, from 1 (omit the feature) to 7 (ship what survives).
- **Load-bearing:** a line that editing must never cut, such as validation, error handling or security. See item 4 below.
- **Margin, redline:** enforcement modes. Margin reports objections; redline (the default) blocks on them. See [Modes](#modes).

1. **The Seven Omissions.** Before writing, try to *not* write it, in order, and stop at the first that holds: (1) omit the feature, (2) the new code, (3) the custom code, (4) the script, (5) the dependency, (6) the ceremony. (7) What survives editing ships: fewest files, shortest diff.
2. **The Fact-Check.** No omission counts without a citation the tool can re-check itself: `file:line:symbol` for "the codebase has this", an executable snippet for "stdlib covers it", a declared dependency plus a snippet for "the dep handles it". A citation only its author can read is a self-report, and a hallucinated shortcut is a fabricated citation.
3. **The Final Draft.** Working code is a first draft. After the tests pass, one ruthless edit of the agent's own diff, then a net report in `.omit/final-draft.md`: files touched, lines added and removed, new dependencies (target 0). `omit audit` prints exactly those numbers. Done means final draft, not green tests.
4. **Load-Bearing Lines.** Editing cuts fat, not walls. Validation at trust boundaries, error handling that prevents data loss, security, accessibility, concurrency correctness and anything explicitly requested are never cut, and adding them is announced, not smuggled or skipped.
5. **Footnotes.** Deliberate omissions go on the record in the code:

```js
// omitted: retries; single caller tolerates failure; add backoff if this goes multi-tenant
```

The full text is in [AGENTS.md](AGENTS.md).

## Receipts

Minimalism is a taste, and taste has no receipt. The failure underneath it does: the agent says "the codebase already does this" or "stdlib covers it", and nobody checks. Every rule file in this genre tells the agent not to lie. omit checks.

Each claim lands in `.omit/receipts.jsonl` with the evidence that settles it:

```json
{"claim":"reuse","rung":2,"file":"src/util.ts","line":1,"symbol":"padTo"}
{"claim":"stdlib","rung":3,"api":"crypto.randomUUID","run":["node","-e","crypto.randomUUID()"]}
{"claim":"new-dep","rung":7,"dep":"left-pad","tried":[{"rung":2,"absent":"padTo"}]}
```

```
$ omit verify
✅ line   1  verified      reuse
✅ line   2  verified      stdlib
⛔ line   3  failed        new-dep
        [new-dep] tried[0] (rung 2) actually HOLDS: padTo is present at src/util.ts — so the omission applies and this dep is not needed

2/3 claims survived re-checking · 1 refuted · 0 unverifiable
```

The third line is the whole idea. A `new-dep` receipt says "I tried the earlier omissions and none held", so it cites the symbol it looked for, omit searches the tree for itself, and a symbol that is there refutes the agent's own conclusion. Run `omit verify` on a PR: "17/17 claims survived" is a number a reviewer can act on, and "3 refuted" names the shortcuts that were invented.

Two bindings keep this honest:

- **`run` must name what it exercises** (`api`, or the dependency), and the argv must mention it. Exit status alone proves nothing: `["true"]` exits 0 and `["false"]` exits 1 while testing nothing.
- **A `tried` entry cites a search, not a location.** A file that merely doesn't exist proves nothing.

A receipt in the old prose shape, or a `tried` entry that cites a file, reads as `unverifiable`, and `omit verify` names each one.

`run` is an argv array, never a shell string: nothing expands, nothing hides in an argument. `.omit/receipts.jsonl` is executable the way a Makefile is, so read it in a PR the same way. `OMIT_NO_EXEC=1` downgrades those checks to "unverifiable" instead of running them. The dependency hook never runs them unless `OMIT_HOOK_EXEC=1`, because a Write of the ledger would otherwise run code as you with no approval prompt.

## Mechanisms

- **Command sentinel.** Before a shell command runs, blocks `rm -rf` of home or a system root, deletes through an unset variable, `dd` to a block device, `mkfs`, fork bombs, `xargs rm -rf` and a bare `find . -delete`.
  - Holds for the user to run: `git clean -f`, `git reset --hard`, `git checkout -- .`, force-push without a lease, `--no-verify`, a rerouted `core.hooksPath`, and `git config omit.trusted …` or `omit.enforce false`.
  - Waive one with a trailing comment that carries a real reason: `# omit-allow: <reason>`. The bare token, a token in a string literal and a reason-less marker are ignored.
- **Dep sentinel.** A new dependency in a manifest with no verified receipt is objected to. Each omission the receipt says was tried is re-checked; if one applies, the dependency is refused.
- **Hazard sentinel.** Blocks hardcoded keys and injection-prone patterns (string-built SQL, `eval`, shell concatenation, `innerHTML`, unsafe deserialization), judged on the lines an edit adds.
  - Secrets have no override: the secret rules run before any marker is read. Injection lines take a trailing `# omit-allow: <reason>`.
- **Leak sentinel.** Blocks a shell command that would print an existing secret to stdout: Keychain, `secret-tool`, `pass`, `gpg -d`, 1Password, Vault, AWS, GCP, Azure and kubectl secret CLIs, bare `env` or `printenv`, `env | grep` for a KEY, TOKEN or SECRET variable, and `cat` of a `.env`, `credentials`, `*.pem` or `id_rsa` file. Also blocks a live key typed into the command line.
  - The same goes for the Read tool opening such a file and Grep printing its lines. Redirecting to a file or piping to a non-printing sink (clipboard, `--password-stdin`) is safe: the goal is to keep secrets out of the transcript, not off disk.
- **TLS rules.** A rule set inside the command and hazard sentinels, not a hook of its own. Switching certificate verification off (environment flags, `curl` and `wget` options, npm, git and pip settings, a verify flag set false in code) is blocked, with the fix that works: trust the proxy's CA (`NODE_EXTRA_CA_CERTS`, `npm config set cafile`, `REQUESTS_CA_BUNDLE`, `git config http.sslCAInfo`, `curl --cacert`). A reviewed line takes `# omit-allow: <reason>`.
- **Tamper sentinel.** The agent under check may not disarm the check. Blocks an edit or command that removes omit's hooks from `.claude/settings*.json`, `.codex/hooks.json`, `.ribhu/hooks.json` or `.git/hooks/`, or writes `.omit/mode`, `.git/config` or the session baseline in `.git/omit/`. Other edits to the hooks files pass.
- **Lint sentinel.** Ships no lint rules. Detects the linter the repo configured (eslint, biome, ruff, flake8) and runs it on each edited file. A configured linter that cannot run (no `node_modules`, nothing on PATH) is reported as *not run* with the reason, never as a pass. The commit gate lints the staged content (an index snapshot), so unstaged edits on disk don't change the result.
- **Final Draft gate.** The session cannot end with an edited tree and no current `.omit/final-draft.md`. The report is read, not just stat'd: its counts are checked against the actual diff, so a stub or stale draft fails. Counts start from a snapshot the SessionStart hook takes, so changes already in the tree are not charged to the session. A subagent that edited files meets the same gate.

Where each runs depends on the host. Under the Claude plugin, the dependency and hazard sentinels object before an edit lands (after, for a manifest rewritten from the shell). Under `omit hook install codex` they are PostToolUse hooks for file edits, so they object after the write, as does the lint sentinel in both. These hooks do not impose a token budget or compact transcripts. Escape hatch for humans: `OMIT_OFF=1`.

## CI

The GitHub Action comments the verdict on every pull request, whatever wrote the code:

```yaml
# .github/workflows/omit.yml
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  omit:
    runs-on: ubuntu-latest
    # A fork's PR gets a read-only token, so the comment could only fail there.
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: sriinnu/omit@v0.9.0
        with: { gate: true, fail-on: secret }
```

The comment carries the same rows as the verdict in the first example, as markdown, and is edited in place on each push.

| Input | Default | Meaning |
|---|---|---|
| `base` | `origin/<PR base>` | Ref to diff against. |
| `exec` | `false` | Run the `run` snippets in `.omit/receipts.jsonl` and the repo's linter. Off because a PR's receipts and lint config are untrusted code; the verdict then says *not run*. |
| `fail-on` | `none` | `secret` fails the check on hardcoded secrets, `hazard` on any hazard. `none` comments only. |
| `gate` | `false` | Also run `omit gate --range` over the PR's commits and fail on a block. Runs from the Action's own checkout with execution off, and needs `fetch-depth: 0` and a `pull_request` event. |

### The gate range

A pre-commit hook runs as the agent it checks, so CI recomputes the verdict. `omit gate --range <base>..<head>` (or `--base <ref>`, meaning `<ref>..HEAD`) checks each commit against its first parent, so a secret added in one commit and removed in the next still fails.

- **Adoption and mode come from the base revision's tree only**, not the head, `OMIT_MODE` or git config. A PR that sets `.omit/mode` to `off` or deletes `.omit/` is still gated by the base's rules.
- **A merge commit** is judged on the lines new relative to all its parents, so a clean merge adds nothing.
- **`--json` prints a versioned verdict**: `omitVersion`, `rulesHash` (sha256 of the rule files), `base`, `head`, `adopted`, `mode`, `exec`, `ok` and `findings`, with sorted keys and no timestamps or paths, byte-identical for the same inputs. `exec: false` marks a run with `OMIT_NO_EXEC` set, where receipts and the linter did not run.
- The head must be the checked-out commit, because receipts and lint read the working tree.

This repo runs the range in its own workflow, [omit-gate.yml](.github/workflows/omit-gate.yml), as a job named `omit-gate`. It uses `pull_request_target`, because on `pull_request` GitHub runs the PR's own copy of the workflow and a PR could keep the job name and swap in steps that pass. `pull_request_target` runs the base branch's definition. That trigger has a write-capable token and secrets, so the job has `contents: read` only, checks the PR out as inert files, and runs omit from the base branch's checkout with `OMIT_NO_EXEC=1`. It never installs or runs anything from the PR.

**Add `omit-gate` to the branch's required checks**, so it can't be deleted. Required checks stop deletion, and `pull_request_target` stops a PR rewriting the job. A CODEOWNERS rule requiring review of `.github/workflows/` is still worth adding.

The Action's `gate` input is consumer-side and runs inside your own `pull_request` job, which a PR can edit. For a gate a PR cannot rewrite, run it from a separate `pull_request_target` workflow like this one, with omit installed outside the PR's checkout.

## What this does not catch

A table of mechanisms invites you to read it as a guarantee. It isn't one. Each item is a known, reproduced limit.

- **The gate runs a repo's own code by default.** `omit gate` runs an adopted repo's receipts (`run` snippets) and its linter. In a repo you cloned, that is someone else's code running as you on your first commit. Set `OMIT_NO_EXEC=1` for repos you haven't read. Range mode in CI already runs with execution off.
- **Writes whose path can't be read out of the command reach no file sentinel.** `python -c "open('f','w').write(...)"`, `curl -o f`, `node -e fs.writeFileSync`. A literal secret in such a command is still caught by the command-text scan; its injection patterns are not. The same goes for a file rewritten through a tool no sentinel is wired to. A shell parser would close this, and a wrong shell parser is worse than none, so omit leaves it out.
- **`omit gate` is a git hook.** `git commit --no-verify` skips it (the command sentinel stops an agent from running that, not a person), and `core.hooksPath` shadows it. `omit audit` and `omit gate` report the shadowing in the verdict. `omit hook install` always writes `.git/hooks/pre-commit` and warns when `core.hooksPath` means git won't run it. Nothing can stop you bypassing your own pre-commit hook.
- **The dependency allowlist is short.** `setup.py`, `build.gradle`, `Package.swift` and `*.csproj` are dependency-shaped and unparsed. A change to one is reported (`unparsed deps: …`) and suppresses the `✅` on the deps row, but the gate does not fail on it, because a `setup.py` in a repo is not evidence of anything.
- **The lint sentinel runs your linter in your session**, which executes your lint config: the same trust as running `npm run lint` yourself. The Action runs neither the linter nor a PR's receipts (untrusted code) unless you set `exec: true`.
- **Receipt evidence is bound to its claim textually.** A snippet that names a symbol without calling it passes. Proving otherwise would mean the verifier writing the snippet, and then it tests the verifier.
- **The leak sentinel misses one shape.** A `for`/`do`/`done > file` loop's trailing redirect isn't attributed back to the loop body. It stays undetected on purpose rather than chasing a fragile fix.

## Other agents

The enforcement logic lives in a zero-dependency CLI, not in any one vendor's hook system. Claude Code's and Codex's hooks are thin adapters over it, and the git hook and the Action cover every other agent.

- **Codex:** `omit init codex` writes `AGENTS.md`; `omit hook install codex` merges the sentinels into `.codex/hooks.json` without duplicating omit's entries on a rerun. Command, leak and tamper sentinels run on `Bash` before execution and the tamper sentinel checks file edits too; dependency, hazard and lint run after the write. Codex asks you to trust new hooks once per session (`/hooks`).
- **npx installs:** installed from an `npx` cache, the hooks call back through npx pinned to the installed version (`omit hook run <hook>`), so they survive the cache being cleaned.
- **[Ribhu](https://github.com/sriinnu/ribhu):** `omit hook install ribhu` writes `.ribhu/hooks.json`; an adapter translates Ribhu's payload so the same sentinels run unchanged, and a hook that cannot run its sentinel blocks rather than passes. Ribhu sends every tool call a code-mode script makes through the hooks, so a script's writes are checked like direct ones. Ribhu runs a repository's hooks only once the project is trusted. Tested with payloads in its shape; not yet watched firing in a live Ribhu session.
- **Cursor, Cline, Windsurf, Copilot:** `omit init cursor | cline | windsurf | copilot` writes `.cursor/rules/omit.mdc`, `.clinerules/omit.md`, `.windsurf/rules/omit.md` or `.github/copilot-instructions.md`. Or copy that file from this repo.
- **Takumi, Gemini CLI, anything else:** `omit init agents` writes `AGENTS.md`. If the agent doesn't read it, paste its contents into the agent's custom-instructions or rules setting (`GEMINI.md` for Gemini CLI). It is plain markdown.
- **Claude Code without the plugin:** `omit init claude` writes `.claude/skills/omit/SKILL.md`, or copy `skills/omit/SKILL.md` to that path (project) or `~/.claude/skills/omit/SKILL.md` (all projects). `omit hook install claude` writes the plugin's hooks into `.claude/settings.json`.

A hook install from a local checkout writes that checkout's absolute paths, which mean nothing on a teammate's machine. To share hooks through a committed `.claude/settings.json`, install with `npx @sriinnu/omit hook install …`, which writes version-pinned `npx` commands, or have everyone use the plugin.

## Commands

**Set up.** `init all` writes `AGENTS.md`, `.agents/skills/omit/SKILL.md`, `.claude/skills/omit/SKILL.md`, `.cursor/rules/omit.mdc`, `.clinerules/omit.md`, `.windsurf/rules/omit.md` and `.github/copilot-instructions.md`.

```
omit init [agents|claude|cursor|cline|windsurf|copilot|skill|codex|takumi|all]   # never overwrites
omit init --check                 # report installed rule files that drifted from this version; writes nothing
omit hook install                 # git pre-commit gate
omit hook install claude|codex|ribhu [--context]   # live sentinels inside that agent
omit hook run <hook>              # run one hook on a payload from stdin
omit mode [margin|redline|rewrite|off]             # print or set the enforcement mode
```

**Check**

```
omit audit                        # net diff (untracked files included), new deps, hazards, receipts, lint
omit audit --base <ref>           # against a ref instead of HEAD
omit audit --session              # counted from when the agent session began; needs the baseline
                                  # the SessionStart hook writes (omit hook install claude)
omit audit --json | --markdown    # other formats
omit audit --fail-on secret|hazard|gate   # exit 1 on secrets, any hazard, or what the gate would block
omit gate                         # the pre-commit check on the staged diff
omit gate --range <base>..<head> [--json]  # every commit in the range, judged by the base's adoption and mode
omit gate --base <ref>            # same as --range <ref>..HEAD
omit check <files>                # hazard-scan specific files
omit lint [files]                 # run the repo's own linter on changed files
omit verify                       # re-check every claim in .omit/receipts.jsonl
omit guard "<cmd>"                # is this shell command a disaster?
omit leak "<cmd>"                 # would this command print a real secret to stdout?
```

`check`, `guard` and `leak` exist to wire omit into any other hook system.

**Claude Code slash commands:** `/omit [margin|redline|rewrite|off]` switches or shows the mode; `/omit-edit` runs an editor's pass over the current diff for bloat, uncited claims, missing footnotes and cut opportunities.

## Extras

### Codemode (experimental)

An agent exploring a repo pays for every intermediate result: each read and grep is a round-trip whose raw output lands in the transcript and is sent again on every later turn. With `omit codemode` the model writes a script, the reads happen inside it, and only what the script returns comes back.

```sh
omit codemode run <<'EOF'
const libs = (await tools.files({ under: 'lib' })).filter((f) => f.endsWith('.mjs'))
const sources = await Promise.all(libs.map((path) => tools.read({ path })))
return Object.fromEntries(libs.map((f, i) => [f, (sources[i].match(/^export /gm) ?? []).length]))
EOF
```

- **Read-only.** Three tools: `files`, `read`, `grep`. They read the tree through git, so ignored files stay out, and every path is confined to the starting directory: no `..`, no absolute path, no symlink out.
- **Sandboxed.** The script runs in a QuickJS VM compiled to wasm ([`@earendil-works/pi-codemode`](https://www.npmjs.com/package/@earendil-works/pi-codemode)): no file system, no network, no `process`. `node:vm` is not isolation, and the receipt for this dependency runs the escape to show it.
- **Secrets stay in.** A script may read a credentials file; it may not return it. Output that matches a secret rule is withheld whole.
- **Bounded.** 60 seconds, and output past 20,000 characters loses its middle.

The sandbox is an optional peer that only this command loads, so omit itself still installs zero dependencies. It needs Node 22.19 or newer: `npm install -g @sriinnu/omit @earendil-works/pi-codemode`.

Any agent with a shell can use `omit codemode run` (script on stdin or from a file), and the `omit-codemode` skill (`skills/omit-codemode/SKILL.md`) teaches when to reach for it. For a host without a shell, or one where you'd rather approve a single read-only tool, the same thing is an MCP server on stdio (`claude mcp add omit -- omit codemode` in Claude Code). It has no write or edit tools on purpose: a nested write is not seen by the host's hooks. For Codex:

```toml
# ~/.codex/config.toml
[mcp_servers.omit]
command = "omit"
args = ["codemode"]
```

### Hook health and context controls

These run locally with Node and call no model or provider API. Other hosts need the stdin contract below; automatic interception is not universal.

```sh
omit doctor                # read-only hook inspection; never runs discovered commands
omit doctor --json         # same findings for scripts; exit 1 on errors
omit hook install codex --context
omit hook install claude --context
```

`omit doctor` inspects global Codex hooks plus the current directory's `.codex/hooks.json`, `.claude/settings.json`, `.claude/settings.local.json` and `.ribhu/hooks.json`. It reports missing scripts, duplicate registrations, malformed matchers, some legacy shell-tool name mismatches, `core.hooksPath` overrides, and an `OMIT_OFF` set to anything but `1`, `0` or empty (`OMIT_OFF=true` silently does nothing). It checks simple Node and Python script commands statically; other command shapes are reported as unchecked. It does not resolve every parent layer, check host trust or executable availability, or prove that hooks fired: `liveDelivery` stays `unverified`.

`--context` adds advisory broad-read warnings and a text output guard that archives very large shell output. [GETTING-STARTED.md](GETTING-STARTED.md#context-controls) has the details, including the stdin contract for other hosts.

### Bench (experimental)

`bench/` makes METHODOLOGY.md runnable: paired agentic runs of the same tasks under baseline, omit or any competing skill, with metrics computed from the actual git diffs and all transcripts kept. See `bench/README.md`.

## Prior art

The minimalism-pressure idea was popularized by [ponytail](https://github.com/DietrichGebert/ponytail), which deserves its stars. omit differs where it matters: shortcuts require citations, the diff is edited *after* it works, safety lines are enumerated and never cut, and what's left out is footnoted instead of silent.

## License

MIT. To contribute or cut a release, see [CONTRIBUTING.md](CONTRIBUTING.md).
