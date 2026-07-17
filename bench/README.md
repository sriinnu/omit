# omit bench (experimental)

The runnable referee for `benchmarks/METHODOLOGY.md`: paired agentic runs of the same tasks under different rule files: baseline, omit, or any competing skill: with every metric computed from the actual git diff and every transcript kept.

```
node bench/run.mjs bench/bench.config.json
```

Copy `bench.config.example.json`, point `tasks[].repo` at real fixture repos with real test suites, and pick your arms. Output lands in `bench/runs/<timestamp>/`: per-run logs, `results.json`, and a median summary table.

Status: **experimental**: the harness runs, but no official numbers exist yet because none have been produced by a run anyone can reproduce. That is the standard; it doesn't bend for the project that set it.

`// omitted: cost/token accounting: agent CLIs report spend differently; add per-agent adapters when the first real run needs them`
