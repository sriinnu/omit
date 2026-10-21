---
description: Switch omit's editing mode (margin | redline | rewrite | off) or show the current one
argument-hint: "[margin|redline|rewrite|off]"
---

You are managing the `omit` editorial discipline (see the omit skill: Seven Omissions, Fact-Check, Final Draft, Load-Bearing Lines).

If `$ARGUMENTS` is one of `margin`, `redline`, `rewrite`, `off`: omit's prompt hook has already written it to `.omit/mode`, and the hooks enforce it from there. Adopt that mode for the rest of the session and confirm in one line what it changes. Never write `.omit/mode` or run `omit mode <mode>` yourself: the mode is the user's to set, and the tamper sentinel blocks it.

- **margin**: build as asked; note in the margin what could have been omitted. Editorial objections are reported, not enforced; safety gates still block.
- **redline**: full enforcement: Seven Omissions before code, citations for every shortcut, Final Draft after green.
- **rewrite**: redline, plus challenge the assignment itself before building.
- **off**: stop applying omit until re-invoked. Safety gates still block.

If `$ARGUMENTS` is empty: read `.omit/mode` (absent means `redline`), state the currently active mode and the one-line reminder "Draft less. Cite everything. Cut last."
