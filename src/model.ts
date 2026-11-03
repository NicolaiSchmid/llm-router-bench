import { z } from "zod";

export const requestSchema = z.strictObject({
	status: z.number().int().optional(),
	ms: z.number().nonnegative(),
	failure: z.enum(["transport", "timeout", "budget"]).optional(),
});
export const attemptSchema = z.strictObject({
	caseId: z.string(),
	contract: z.string(),
	feature: z.string(),
	layer: z.enum(["wire", "sdk"]),
	sdk: z.string().nullable(),
	repetition: z.number().int().positive(),
	state: z.enum(["completed", "skipped", "aborted"]),
	outcome: z.enum(["pass", "fail"]).nullable(),
	category: z.enum([
		"none",
		"not_applicable",
		"unknown",
		"unsupported",
		"protocol",
		"sdk",
		"behavior",
		"http_5xx",
		"rate_limit",
		"timeout",
		"transport",
		"configuration",
		"budget",
	]),
	assertion: z.enum(["positive", "negative", "diagnostic"]),
	ms: z.number().nonnegative(),
	requests: z.array(requestSchema),
});
export type Attempt = z.infer<typeof attemptSchema>;
export const runSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: z.string(),
	start: z.string().datetime(),
	end: z.string().datetime(),
	suiteVersion: z.string(),
	suiteCommit: z.string(),
	lockfileSha256: z.string(),
	caseSetSha256: z.string(),
	sdkVersions: z.record(z.string(), z.string()),
	target: z.strictObject({
		provider: z.string(),
		baseUrl: z.string().url(),
		model: z.string(),
		protocol: z.string(),
		backend: z.literal("unknown"),
	}),
	settings: z.strictObject({
		suite: z.enum(["core", "legacy"]),
		repetitions: z.number().int().positive(),
		maxRequests: z.number().int().positive(),
		maxOutputTokens: z.number().int().positive(),
		timeoutMs: z.number().int().positive(),
		intervalMs: z.number().int().nonnegative(),
		concurrency: z.literal(1),
		retries: z.literal(0),
		routePolicy: z.string(),
		runner: z.string(),
		region: z.string(),
	}),
	completion: z.enum(["complete", "partial", "invalid"]),
	attempts: z.array(attemptSchema),
});
export type Run = z.infer<typeof runSchema>;
export type BenchmarkCase = {
	id: string;
	contract: string;
	feature: string;
	layer: "wire" | "sdk";
	sdk: string | null;
	assertion: Attempt["assertion"];
	skip?: boolean;
	run: () => Promise<void>;
};
