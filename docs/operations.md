# Run and publish measurements

The repository starts with paid schedules disabled and no live credentials.
Offline checks and report generation work immediately. The six provider key names
are defined once in `providers/index.json` and documented in `.env.example`.

1. Add provider API keys as secrets on a GitHub environment named `benchmark`.
   Restrict deployment branches to `main`; configure required reviewers when
   account policy allows. Do not use production customer credentials.
2. Run the benchmark workflow manually with a provider and explicit model ID.
   It checks out current `main`, supplies only that provider's key, limits requests
   and output tokens, and uploads sanitized results even when assertions fail.
   A failed run without a valid result artifact is an operational incident, not
   a zero-error sample. Workflow history is its visible incident record.
3. Review the downloaded `benchmark-results-*` artifact, copy its `results/`
   subtree into the repository, run `npm run validate:results` and `npm run report`,
   and open a result PR. Initial publication is deliberately reviewed. The workflow
   does not need repository write access or permission to open pull requests.
4. For recurring execution, populate `schedules/targets.json` with reviewed targets
   using the example shape there. Set repository variable `LIVE_BENCHMARKS_ENABLED`
   to `true` only after selecting a monthly spend ceiling and an owner to monitor
   billing. Daily core runs and weekly diagnostic runs then execute these targets.
   Provider-specific concurrency prevents overlapping scheduled/manual samples.
   Request/token caps are per target run; provider billing limits are required for
   a dollar ceiling. There is no automatic monthly dollar enforcement in the CLI.
5. Enable GitHub Pages using GitHub Actions, then run the report workflow or merge
   result data. It validates measurements and publishes only the generated static
   site and sanitized run evidence. The report remains empty until measured data
   is committed.

Use separate accounts/keys with provider-side spending limits. Never run live
benchmarks on fork PRs, `pull_request_target`, or arbitrary contributed code. The
trusted workflow rejects manual dispatch from non-default branches. Offline PR
CI has no credentials. The suite does not configure or change provider accounts.

Review SDK dependency updates together with scenario mappings. Current versions
are pinned in the lockfile; `npm ci` is the reproducible install. Additional SDK
versions need isolated installations and separate result series. Python SDKs,
Gemini, Azure, Bedrock, and automated bot result PRs are deferred.

Monitor publication volume before increasing cadence. Measurements are compact
JSON files in Git for now; partition by UTC year/month and keep a stable run ID.
There is no external results database. Do not delete unsuccessful measurements
merely because they make a provider look bad.
