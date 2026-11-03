import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildCases } from "./cases.ts";
import { type Config, providers } from "./config.ts";
import { instrument, measure } from "./measure.ts";
import type { BenchmarkCase, Run } from "./model.ts";
import { runSchema } from "./model.ts";
import { metrics, support, wilson } from "./report.ts";

const restorers: (() => void)[] = [];
afterEach(() => {
	for (const f of restorers.splice(0)) f();
});
const testCase = (run: () => Promise<void>): BenchmarkCase => ({
	id: "test",
	contract: "test-1",
	feature: "text",
	layer: "sdk",
	sdk: "langchain",
	assertion: "positive",
	run,
});
async function serve(handler: (body: Record<string, unknown>) => unknown) {
	const server = createServer(async (req, res) => {
		let text = "";
		for await (const c of req) text += c;
		const data = handler(JSON.parse(text || "{}"));
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(data));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((e) => (e ? reject(e) : resolve())),
			),
	};
}
describe("live SDK replay and accounting", () => {
	it("runs the real LangChain OpenAI client against an offline response and records requests without content", async () => {
		const bodies: Record<string, unknown>[] = [];
		const server = await serve((body) => {
			bodies.push(body);
			return {
				id: "chatcmpl-fixture",
				object: "chat.completion",
				created: 1,
				model: "fixture",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "hello" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
			};
		});
		const transport = instrument({
			maxRequests: 1,
			intervalMs: 0,
			timeoutMs: 1000,
			maxOutputTokens: 64,
		});
		restorers.push(transport.restore);
		try {
			const model = new ChatOpenAI({
				apiKey: "synthetic-secret",
				model: "fixture",
				configuration: { baseURL: server.url },
				maxRetries: 0,
			});
			const a = await measure(
				testCase(async () => {
					expect((await model.invoke("synthetic input")).content).toBe("hello");
				}),
				1,
			);
			expect(a.outcome).toBe("pass");
			expect(a.requests).toHaveLength(1);
			expect(bodies[0]?.max_tokens).toBe(64);
			expect(JSON.stringify(a)).not.toMatch(/synthetic|hello|Bearer/);
			const blocked = await measure(
				testCase(async () => {
					await model.invoke("again");
				}),
				2,
			);
			expect(blocked.category).toBe("budget");
			expect(blocked.state).toBe("aborted");
			expect(transport.used()).toBe(1);
		} finally {
			transport.restore();
			await server.close();
		}
	});
	it("runs the real LangChain Anthropic client against a native Messages fixture", async () => {
		const server = await serve(() => ({
			id: "msg-fixture",
			type: "message",
			role: "assistant",
			model: "fixture",
			content: [{ type: "text", text: "hello" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 3, output_tokens: 1 },
		}));
		const transport = instrument({
			maxRequests: 2,
			intervalMs: 0,
			timeoutMs: 1000,
			maxOutputTokens: 64,
		});
		restorers.push(transport.restore);
		try {
			const model = new ChatAnthropic({
				apiKey: "synthetic",
				model: "fixture",
				clientOptions: { baseURL: server.url },
				maxRetries: 0,
				maxTokens: 64,
			});
			const a = await measure(
				testCase(async () => {
					expect((await model.invoke("hello")).content).toBe("hello");
				}),
				1,
			);
			expect(a.outcome).toBe("pass");
			expect(a.requests).toHaveLength(1);
		} finally {
			transport.restore();
			await server.close();
		}
	});
	it("does not treat generic refusals as proof of absent support", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = async () => new Response("{}", { status: 400 });
		restorers.push(() => {
			globalThis.fetch = original;
		});
		const transport = instrument({
			maxRequests: 2,
			intervalMs: 0,
			timeoutMs: 1000,
			maxOutputTokens: 64,
		});
		restorers.push(transport.restore);
		const a = await measure(
			testCase(async () => {
				const r = await fetch("https://example.com");
				if (!r.ok) throw new Error("untrusted server message");
			}),
			1,
		);
		expect(a.category).toBe("unknown");
		expect(JSON.stringify(a)).not.toContain("untrusted");
	});
});
it("preserves deliberately malformed JSON instead of failing locally", async () => {
	const original = globalThis.fetch;
	let received = "";
	globalThis.fetch = async (input, init) => {
		received = await new Request(input, init).text();
		return new Response("{}", { status: 400 });
	};
	const transport = instrument({
		maxRequests: 1,
		intervalMs: 0,
		timeoutMs: 1000,
		maxOutputTokens: 64,
	});
	try {
		const a = await measure(
			{
				...testCase(async () => {
					const r = await fetch("https://example.com/chat/completions", {
						method: "POST",
						body: "{invalid",
					});
					expect(r.status).toBe(400);
				}),
				assertion: "negative",
			},
			1,
		);
		expect(a.outcome).toBe("pass");
		expect(received).toBe("{invalid");
		expect(a.requests).toHaveLength(1);
	} finally {
		transport.restore();
		globalThis.fetch = original;
	}
});
describe("selection and metrics", () => {
	it("configures exactly the six agreed providers and LangChain on applicable core surfaces", () => {
		expect(providers.map((p) => p.id)).toEqual([
			"openai",
			"anthropic",
			"requesty",
			"openrouter",
			"mistral",
			"modus",
		]);
		for (const provider of providers) {
			const c = {
				provider,
				model: "fixture",
				protocol: provider.protocols[0],
				suite: "core",
				apiKey: "synthetic",
				baseUrl: provider.baseUrl,
				maxOutputTokens: 64,
				timeoutMs: 1000,
			} as Config;
			const cases = buildCases(c);
			expect(cases.filter((c) => c.sdk === "langchain")).toHaveLength(4);
			expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
		}
	});
	it("excludes negative requests and incomplete runs from reliability denominators", async () => {
		const positive = await measure(
			testCase(async () => {}),
			1,
		);
		positive.requests = [
			{ status: 200, ms: 1 },
			{ status: 429, ms: 1 },
		];
		const negative = {
			...positive,
			caseId: "negative",
			assertion: "negative" as const,
			requests: [{ status: 401, ms: 1 }],
		};
		const run = {
			completion: "complete",
			settings: { suite: "core" },
			attempts: [positive, negative],
		} as Run;
		expect(metrics(run).reliability).toMatchObject({
			errors: 1,
			total: 2,
			rateLimits: 1,
		});
		expect(
			metrics({ ...run, settings: { ...run.settings, suite: "legacy" } })
				.reliability.total,
		).toBe(0);
		expect(metrics({ ...run, completion: "invalid" }).reliability.total).toBe(
			0,
		);
		expect(wilson(0, 0)).toBeNull();
		expect(wilson(0, 10)?.[1]).toBeGreaterThan(0);
		expect(
			support([positive, { ...positive, outcome: "fail", category: "sdk" }]),
		).toBe("partial");
	});
	it("rejects fields outside the publication allowlist", () => {
		expect(runSchema.safeParse({ serverBody: "secret" }).success).toBe(false);
	});
});
