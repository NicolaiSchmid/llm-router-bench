# MODUS extraction boundary

Reusable conformance cases, schemas, generated fixtures, SDK scenarios, and offline
checker tests were extracted from `NicolaiSchmid/june`, source commit
`f41a4ed33`. Original case IDs are retained under `src/conformance/`.

The gateway-specific mock, expected-failure policy, Convex implementation,
provider-specific specialized probes, and historical Telekom artifacts were not
published here. They remain in the source repository. The extracted legacy
report module exists for the original offline regression tests; new public run
files and reports use `src/model.ts` and `src/report.ts` instead.

The source repository has not yet removed its original suite. The safe cutover
requires running this public version against the deployed MODUS endpoint,
checking parity and provenance, then pinning a published package/tag in the local
integration harness before deleting duplicated cases. No paid reference run or
npm publication is implied by repository creation. The broad legacy suite is
available here while keeping the original gateway regression harness operational.
