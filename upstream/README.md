# SDK scenario provenance

`scenarios.json` maps SDK-derived expectations to inspected upstream sources at
immutable commits. Local scenarios are rewritten for synthetic, live endpoint
execution; upstream mocking helpers, credentials, prompts, and implementation
code are not vendored or executed. Upstream repositories license the inspected
tests under MIT; the links and copyright attribution are retained below.

- LangChain.js: Copyright LangChain, Inc.; MIT. `testInvoke`, `testStream`,
  `testWithStructuredOutput`, and tool-history tests provide the expectations for
  the LangChain lane. Provider standard-test entrypoints establish applicability.
- OpenAI Node: Copyright OpenAI; MIT. Streaming helper tests supply expectations
  for accumulated final completions, finish reasons, and parsed tool arguments.
- Anthropic TypeScript SDK: Copyright Anthropic, PBC; MIT. Messages resource tests
  supply the create/public-result expectation. Streaming assertions are local
  additions and do not claim direct derivation from the resource create test.

Extracted Vercel AI SDK scenarios and other original wire cases are independently
written tests, with source provenance in NOTICE. Their presence does not mean
this repository has imported the complete upstream SDK test suite. The first
release pins one current version per SDK. A future update must review mappings
and offline/live applicability rather than auto-executing downloaded tests.
