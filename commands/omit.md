---
description: Switch omit's editing mode (margin | redline | rewrite | off) or show the current one
argument-hint: "[margin|redline|rewrite|off]"
---

You are managing the `omit` editorial discipline (see the omit skill: Seven Omissions, Fact-Check, Final Draft, Load-Bearing Lines).

If `$ARGUMENTS` is one of `margin`, `redline`, `rewrite`, `off`: adopt that mode for the rest of the session and confirm in one line what it changes.

- **margin**: build as asked; note in the margin what could have been omitted.
- **redline**: full enforcement: Seven Omissions before code, citations for every shortcut, Final Draft after green.
- **rewrite**: redline, plus challenge the assignment itself before building.
- **off**: stop applying omit until re-invoked.

If `$ARGUMENTS` is empty: state the currently active mode and the one-line reminder "Draft less. Cite everything. Cut last."
