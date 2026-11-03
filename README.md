# llm-router-bench

Measure whether an AI provider works with the API features and SDKs your
application uses. This public repository contains the test suite and its result
history. A static report is generated from checked-in measurements.

Initial providers: **OpenAI, Anthropic API, Requesty, OpenRouter, Mistral, MODUS**.
SDK targets: **OpenAI JavaScript SDK, Anthropic TypeScript SDK, Vercel AI SDK,
LangChain.js** (`@langchain/openai` and `@langchain/anthropic`). LangChain is tested
on Chat Completions and native Messages; Responses currently uses OpenAI and
Vercel clients. Provider profiles are candidate surfaces, not support claims.

No live results are bundled yet. Offline fixtures are never published as provider
measurements. Authored by [MODUS](https://www.modusservice.com), founded by Nicolai
Schmid; the same public assertions apply to MODUS and competing providers.

## Run locally

Use Node 24 and npm. No monorepo checkout or MODUS service is required.

```sh
npm ci
npm run check
npm run bench -- --help
```

Export the matching provider key from `.env.example` in your shell. The runner
never accepts keys as command arguments and does not automatically load `.env`.
Then supply an exact model ID available to your account:

```sh
npm run bench -- --provider openrouter --model '<model-id>' --repetitions 10 --max-requests 500
npm run bench -- --provider anthropic --model '<model-id>' --protocol messages
npm run bench -- --provider openai --model '<model-id>' --protocol responses
```

Replace the placeholders before running. A core run covers text, streaming,
tools, structured output where implemented, real clients, and invalid-key error
handling. Failures return exit 1 **after saving** results. Invalid configuration
returns exit 2. Authentication/billing failures stop and invalidate the target
sample; exhausted request budgets save a partial run. There are no retries.

`--suite legacy` runs the broader extracted OpenRouter-oriented diagnostic
cases. Metadata-dependent, negative-capability, and heavy upload cases are
skipped until their prerequisites are configured. Legacy results stay separate
from the core comparison and reliability denominators. Use the exported case
modules for detailed integration harnesses; no gateway mock is included here.

Run limits are explicit: `--max-requests` (default 100), `--max-output-tokens`
(default 1024), `--timeout-seconds` (default 90), `--interval-ms` (default 1000),
`--repetitions` (default 1). The transport applies the declared output cap to
wire and SDK requests, including SDK helper calls. Model reasoning can consume
that budget; increase it deliberately for reasoning models. These limits bound
requests and requested output, **not dollar spend or input token charges**.
Requests run serially. The CLI supports same-host `--base-url` overrides for
provider path changes; redirect following is disabled to protect credentials.

```sh
npm run validate:results
npm run report
npm run build
node dist/cli.js --help
```

Open `site/index.html` to inspect the local report. Report artifacts include
portable evidence links and `summary.json`. `results/` is the append-only data
home. Never add API keys, production prompts, arbitrary server messages, account
identifiers, or customer content.

## Understand a result

Read [methodology](docs/methodology.md) before comparing providers. Every run
identifies the endpoint, model, protocol, SDK versions, suite revision, case-set
hash, limits, and measurement window. There is no aggregate provider ranking.
A refusal, a skipped probe, and an SDK parsing error have different meanings.

SDK-derived scenarios have pinned source mappings in [upstream](upstream/README.md).
The upstream sources were inspected; no upstream test code is downloaded or
executed during benchmark runs. The full extracted suite also retains original
cases which were independently authored; do not describe all cases as SDK-derived.

## Automate and contribute

See [operations](docs/operations.md) to enable scheduled runs and publication.
Paid schedules are initially disabled. Offline CI validates changes without
provider keys. Trusted manual runs are available through the benchmark workflow
once keys are configured in the `benchmark` environment. Paid runs use the
current default branch, never a fork or unreviewed workflow branch.

Original code: Apache-2.0. Original measurements: CC-BY-4.0; see `results/LICENSE`.
See [NOTICE](NOTICE) for extraction provenance. The local MODUS gateway
integration harness and historical evidence remain in their original repository;
[handover](docs/handover.md) records the cutover boundary.
