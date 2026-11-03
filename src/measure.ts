import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { Attempt, BenchmarkCase } from "./model.ts";
export class BudgetExceeded extends Error {}
const context = new AsyncLocalStorage<Attempt["requests"]>();
/** Count real requests across wire and SDK calls; no output or headers enter results. */
export function instrument(options: {
	maxRequests: number;
	intervalMs: number;
	timeoutMs: number;
	maxOutputTokens: number;
}) {
	const original = globalThis.fetch;
	let count = 0;
	let next = 0;
	globalThis.fetch = async (input, init) => {
		const records = context.getStore();
		if (count >= options.maxRequests) {
			records?.push({ ms: 0, failure: "budget" });
			throw new BudgetExceeded();
		}
		count++;
		const start = Math.max(Date.now(), next);
		next = start + options.intervalMs;
		if (start > Date.now())
			await new Promise((r) => setTimeout(r, start - Date.now()));
		const clock = performance.now();
		try {
			// A final transport deadline also covers SDKs which forget to pass an abort signal.
			let req = new Request(input, init);
			const url = new URL(req.url);
			if (
				req.method === "POST" &&
				/\/(chat\/completions|responses|messages)$/.test(url.pathname)
			) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(await req.clone().text());
				} catch {
					/* Deliberately malformed diagnostic body: send unchanged. */
				}
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					const body = parsed as Record<string, unknown>;
					const key = url.pathname.endsWith("/responses")
						? "max_output_tokens"
						: "max_completion_tokens" in body
							? "max_completion_tokens"
							: "max_tokens";
					const requested = body[key];
					body[key] =
						typeof requested === "number"
							? Math.min(requested, options.maxOutputTokens)
							: options.maxOutputTokens;
					req = new Request(req, { body: JSON.stringify(body) });
				}
			}
			const signal = AbortSignal.any([
				req.signal,
				AbortSignal.timeout(options.timeoutMs),
			]);
			const response = await original(req, { signal, redirect: "error" });
			records?.push({
				status: response.status,
				ms: Math.round(performance.now() - clock),
			});
			return response;
		} catch (error) {
			records?.push({
				ms: Math.round(performance.now() - clock),
				failure:
					error instanceof Error && /Timeout|Abort/.test(error.name)
						? "timeout"
						: "transport",
			});
			throw error;
		}
	};
	return {
		restore: () => {
			globalThis.fetch = original;
		},
		used: () => count,
	};
}
export function classify(
	error: unknown,
	requests: Attempt["requests"],
	layer: "wire" | "sdk",
	invalidCredentials = false,
): Attempt["category"] {
	if (requests.some((r) => r.failure === "budget")) return "budget";
	if (
		requests.some(
			(r) => r.status === 401 || r.status === 403 || r.status === 402,
		)
	)
		return invalidCredentials ? "protocol" : "configuration";
	if (requests.some((r) => r.status === 429)) return "rate_limit";
	if (requests.some((r) => r.status === 501)) return "unsupported";
	if (requests.some((r) => (r.status ?? 0) >= 500)) return "http_5xx";
	if (requests.some((r) => r.failure === "timeout")) return "timeout";
	if (requests.some((r) => r.failure === "transport")) return "transport";
	// A generic 400 or 404 does not prove a feature is unsupported.
	if (requests.some((r) => (r.status ?? 0) >= 400)) return "unknown";
	if (error instanceof Error && /Timeout|Abort/.test(error.name))
		return "timeout";
	if (error instanceof BehavioralFailure) return "behavior";
	return layer === "sdk" ? "sdk" : "protocol";
}
export class BehavioralFailure extends Error {}
export async function measure(
	c: BenchmarkCase,
	repetition: number,
): Promise<Attempt> {
	const requests: Attempt["requests"] = [];
	const base = {
		caseId: c.id,
		contract: c.contract,
		feature: c.feature,
		layer: c.layer,
		sdk: c.sdk,
		repetition,
		assertion: c.assertion,
		requests,
	};
	if (c.skip)
		return {
			...base,
			state: "skipped",
			outcome: null,
			category: "not_applicable",
			ms: 0,
		};
	const clock = performance.now();
	try {
		await context.run(requests, c.run);
		return {
			...base,
			state: "completed",
			outcome: "pass",
			category: "none",
			ms: Math.round(performance.now() - clock),
		};
	} catch (error) {
		const category = classify(error, requests, c.layer, c.invalidCredentials);
		return {
			...base,
			state: category === "budget" ? "aborted" : "completed",
			outcome: category === "budget" ? null : "fail",
			category,
			ms: Math.round(performance.now() - clock),
		};
	}
}
