# Working on llm-router-bench

Read README.md and docs/methodology.md. Keep the test suite independent of MODUS
implementation code. All six provider profiles use the same public assertions
for applicable protocols. Never include keys, customer data, arbitrary server
messages, or model output in published results or CI logs.

Run npm run check, npm run validate:results, and npm run report before handoff.
Tests are offline; paid runs need explicit operator configuration. Do not enable
schedules or add provider secrets as part of a routine code change. Test the real
SDK against controlled fixtures and preserve pinned upstream scenario mappings.

Results are append-only and strictly schema validated. Do not label skips as
unsupported or exclude expected failures from public metrics. Keep SDK versions,
case-set contracts, and native protocols distinguishable. Use Conventional
Commits with agent Co-Authored-By trailers; review and merge PRs with merge commits.
