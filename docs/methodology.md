# How to read the matrix

A row describes a particular endpoint, model, API surface, and SDK version during
a recorded window. It does not establish support for every model from a provider
or establish a provider-wide uptime SLA. Different models, limits, test contracts,
SDK versions, regions, or case sets are separate series.

The core suite runs safe positive probes even when a provider does not advertise
capabilities. A provider profile states which protocol we intend to test; it is
not a measured support declaration. Metadata-dependent legacy checks remain
skipped when prerequisites are unknown. OpenRouter catalog extensions and MODUS
limits are not universal API requirements.

Each attempt records execution state, outcome, failure category, duration, and
actual HTTP request statuses/timings. Expected failures receive no discount.
Passing negative tests establish error handling only. Generic 400/404 responses
are classified unknown, not unsupported. HTTP 501 is classified unsupported;
other server failures, rate limits, timeouts, transport errors, SDK exceptions,
and assertion failures remain distinct. Model-behavior assertions are marked
where explicitly identified; older extracted assertions may still appear as
protocol/SDK failures, so inspect their case definition before attribution.

An observation is `untested` when no attempt completed, `observed pass` when all
executed attempts passed, `partial` when outcomes differ, `refused` when all
failures explicitly signal unsupported operation, and `observed failure`
otherwise. These are observations, not an inferred guarantee of support.

Compatibility failure rate is failed completed applicable scenario attempts /
completed applicable scenario attempts. This includes error-handling assertions,
which remain separately identified. Request error rate uses **only core positive
workload requests**, including every HTTP request in tool round trips; unexpected
HTTP errors and fetch failures count as request errors. Negative and legacy
requests are excluded. Rate limits are shown separately and included in the
inclusive error count. Body/stream errors after successful headers fail the
scenario, but may not appear in the fetch-header request-error count; use both
metrics together. Request timing currently measures time to headers, while
scenario duration covers complete stream consumption and tool loops.

Incomplete and invalid runs remain visible but are excluded from headline rates.
No-request SDK failures fail the scenario without inventing an HTTP request.
The runner has no automatic retries. A run uses serial requests and a documented
output cap applied at transport time. Settings, suite/lockfile/case-set hashes,
resolved dependency versions, and UTC times are retained. Provider fallback and
backend routing remain unknown unless independently verified; route-policy text
is operator context rather than a verified route assertion.

Request-error summaries include a 95% Wilson interval. Its independent-observation
assumption can be violated by tool loops and time clustering; small samples are
preliminary. Spread repetitions across time and match workloads before making
longitudinal claims. The initial cadence is a daily core panel and weekly legacy
panel, configured by the operator. A ten-repeat core pilot helps size later
sampling; it is not a precision guarantee.

Only synthetic fixtures are allowed. Run files are strictly schema validated and
contain no model output, response messages, prompts, keys, or request headers.
SDK warning/error logging is suppressed during execution. Provider/profile labels
are operator-authored public metadata and must not contain secrets. Cases and
fixtures carry provenance through the suite commit; fixtures are generated from
source or use the pinned upstream URLs in the extracted case definitions.

Results are immutable. A correction should add a new run and a documented
supersession record, not silently edit old measurements. Legacy Telekom evidence
has not been imported: old single-run data lacks the attempt history needed for
these rates. There are no model-quality rankings, load tests, or inferred uptime
claims. Changes to assertions or dependency versions require reviewed changes;
new suite/case hashes keep historical measurements distinguishable.
