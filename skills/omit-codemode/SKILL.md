---
name: omit-codemode
description: "Explore a repository with one sandboxed script instead of many separate reads and searches, so only the answer reaches the conversation. Use when a task needs three or more reads or greps, a loop over files, or a count or summary across the codebase. Read-only."
---

# omit codemode

*Omit needless context.*

Every separate read or grep puts its raw output into the conversation, where it is paid for again on every later turn. Write one script instead: the reads happen inside it, and only what it returns comes back.

## Run it

```sh
omit codemode run <<'EOF'
const libs = (await tools.files({ under: 'lib' })).filter((f) => f.endsWith('.mjs'))
const sources = await Promise.all(libs.map((path) => tools.read({ path })))
return Object.fromEntries(libs.map((f, i) => [f, (sources[i].match(/^export /gm) ?? []).length]))
EOF
```

Quote the delimiter (`'EOF'`) so the shell leaves the script alone. Exit status 1 means the script failed or its result was withheld.

## The script

The body of an async function: `await` and `return` work at the top level.

| Call | Resolves to |
|---|---|
| `tools.files({ under? })` | `string[]`: tracked and untracked files, minus what git ignores |
| `tools.read({ path })` | `string`: one file as text |
| `tools.grep({ pattern, under? })` | `{ path, line, text }[]`: extended regular expression; no match is `[]` |

`text(value)` adds to the output and `return` adds the returned value. A call that fails rejects with an `Error`; use `Promise.allSettled` to keep the calls that worked. Run independent calls together with `Promise.all`.

There is nothing else in there: no file system, network, `process` or timers. Paths are relative to the current directory and cannot leave it.

## Return the conclusion

- Return counts, names and the few lines that matter, not file contents. Past 20,000 characters the middle of the result is cut.
- A result that contains a secret is withheld whole. Filter it out in the script.
- A script has 60 seconds.

## When not to

- One file or one search: use the ordinary tool.
- Anything that writes. Codemode is read-only: make edits with the ordinary tools, where the sentinels see them.
- If the command says its sandbox is not installed, give the user the install line it prints and carry on with ordinary tools. Do not work around it.
