import { createAnthropic } from "@ai-sdk/anthropic";
import Anthropic from "@anthropic-ai/sdk";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { generateText, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import type { Config } from "./config.ts";
import { chatCases } from "./conformance/cases/chat.ts";
import { clientCases } from "./conformance/cases/client.ts";
import { errorCases } from "./conformance/cases/errors.ts";
import { responsesCases } from "./conformance/cases/responses.ts";
import { post, type Target } from "./conformance/http.ts";
import { type Case, check } from "./conformance/suite.ts";
import { BehavioralFailure } from "./measure.ts";
import { checkMessagesStream } from "./messages-stream.ts";
import type { BenchmarkCase } from "./model.ts";

const prompt = "Reply with the word hello.";
const weatherSchema = z.object({ city: z.string() });
const citySchema = z.object({ city: z.string(), country: z.string() });
export function buildCases(config: Config): BenchmarkCase[] {
	const t: Target = {
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		model: config.model,
		timeoutMs: config.timeoutMs,
	};
	const prefix = config.protocol === "responses" ? "responses." : "chat.";
	const wrap = (c: Case, legacy = false): BenchmarkCase => ({
		id: c.id,
		contract: legacy ? "legacy-openrouter-1" : "openai-surface-1",
		feature: c.feature,
		layer: c.id.startsWith("client.") ? "sdk" : "wire",
		sdk: c.id.startsWith("client.ai-")
			? "vercel-ai"
			: c.id.startsWith("client.openai-")
				? "openai"
				: null,
		assertion: c.id.startsWith("errors.")
			? "negative"
			: legacy
				? "diagnostic"
				: "positive",
		invalidCredentials: /-(missing|invalid)-key$/.test(c.id),
		skip: !!c.lacks?.length || !!c.requiresKnownCapabilities || !!c.heavy,
		run: () => c.run(t),
	});
	const wire = config.protocol === "responses" ? responsesCases : chatCases;
	let selected: BenchmarkCase[] = [];
	if (config.protocol !== "messages") {
		if (config.suite === "legacy")
			selected = [
				...wire,
				...errorCases.filter(
					(c) =>
						!c.id.includes(
							config.protocol === "responses" ? ".chat" : ".responses",
						) && c.id !== "models.list.ids-routable",
				),
				...clientCases.filter((c) =>
					config.protocol === "responses"
						? c.id.includes("responses")
						: !c.id.includes("responses"),
				),
			].map((c) => wrap(c, true));
		else {
			const ids = new Set([
				`${prefix}basic.shape`,
				`${prefix}tools.call`,
				`${prefix}tool-choice.required`,
				config.protocol === "responses"
					? "responses.stream.order"
					: "chat.stream.shape",
				config.protocol === "responses"
					? "responses.text-format.json-schema"
					: "chat.json-schema.strict",
			]);
			selected = wire.filter((c) => ids.has(c.id)).map((c) => wrap(c));
			const clientIds =
				config.protocol === "responses"
					? [
							"client.ai-responses.generate",
							"client.ai-responses.stream",
							"client.ai-responses.tool-round-trip",
							"client.ai-responses.object",
							"client.openai-responses.stream",
							"client.openai-responses.stream-tool-call",
						]
					: [
							"client.ai-chat.generate",
							"client.ai-chat.stream",
							"client.ai-chat.tool-round-trip",
							"client.ai-chat.object",
							"client.openai-chat.stream-tool-call",
							"client.openai-chat.parse",
						];
			selected.push(
				...clientCases
					.filter((c) => clientIds.includes(c.id))
					.map((c) => wrap(c)),
			);
		}
	}
	const add = (
		id: string,
		feature: string,
		layer: "wire" | "sdk",
		sdk: string | null,
		run: () => Promise<void>,
		assertion: BenchmarkCase["assertion"] = "positive",
	) =>
		selected.push({
			id,
			feature,
			layer,
			sdk,
			run,
			invalidCredentials: id.endsWith(".invalid-key"),
			assertion,
			contract:
				config.protocol === "messages"
					? "anthropic-messages-1"
					: config.protocol === "responses"
						? "openai-responses-1"
						: "openai-chat-1",
		});
	if (config.protocol === "messages") {
		const sdk = new Anthropic({
			apiKey: t.apiKey,
			baseURL: t.baseUrl.replace(/\/v1$/, ""),
			maxRetries: 0,
			timeout: t.timeoutMs,
		});
		const opts = {
			model: t.model,
			max_tokens: config.maxOutputTokens,
			messages: [{ role: "user" as const, content: prompt }],
		};
		const native = async (stream: boolean) => {
			const response = await fetch(`${t.baseUrl}/messages`, {
				method: "POST",
				headers: {
					"x-api-key": t.apiKey,
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				},
				body: JSON.stringify({ ...opts, stream }),
			});
			check(response.status === 200, "native status");
			if (stream) {
				await checkMessagesStream(response);
			} else {
				const b = (await response.json()) as {
					type?: string;
					content?: unknown[];
					usage?: { input_tokens?: number };
				};
				check(
					b.type === "message" &&
						b.content?.length &&
						(b.usage?.input_tokens ?? 0) > 0,
					"native shape",
				);
			}
		};
		add("messages.basic", "text", "wire", null, () => native(false));
		add("messages.stream", "stream", "wire", null, () => native(true));
		add("client.anthropic.generate", "text", "sdk", "anthropic", async () => {
			const m = await sdk.messages.create(opts);
			check(
				m.content.some((c) => c.type === "text" && c.text.length > 0),
				"no SDK text",
			);
		});
		add("client.anthropic.stream", "stream", "sdk", "anthropic", async () => {
			const m = await sdk.messages.stream(opts).finalMessage();
			check(
				m.content.some((c) => c.type === "text" && c.text.length > 0),
				"no final SDK text",
			);
			check(m.stop_reason, "no stop reason");
		});
		add("client.anthropic.tools", "tools", "sdk", "anthropic", async () => {
			const m = await sdk.messages.create({
				...opts,
				messages: [
					{ role: "user", content: "Use the weather tool for Berlin." },
				],
				tools: [
					{
						name: "weather",
						description: "Get weather",
						input_schema: {
							type: "object",
							properties: { city: { type: "string" } },
							required: ["city"],
						},
					},
				],
				tool_choice: { type: "tool", name: "weather" },
			});
			check(
				m.content.some(
					(c) =>
						c.type === "tool_use" &&
						c.name === "weather" &&
						weatherSchema.safeParse(c.input).success,
				),
				"missing tool",
			);
		});
		const model = createAnthropic({ apiKey: t.apiKey, baseURL: t.baseUrl })(
			t.model,
		);
		const aiOpts = {
			model,
			messages: opts.messages,
			maxOutputTokens: config.maxOutputTokens,
			maxRetries: 0,
			abortSignal: AbortSignal.timeout(t.timeoutMs),
		};
		add("client.ai-messages.generate", "text", "sdk", "vercel-ai", async () => {
			check(
				(
					await generateText({
						...aiOpts,
						abortSignal: AbortSignal.timeout(t.timeoutMs),
					})
				).text,
				"no AI SDK text",
			);
		});
		add("client.ai-messages.stream", "stream", "sdk", "vercel-ai", async () => {
			const r = streamText({
				onError: () => {},
				...aiOpts,
				abortSignal: AbortSignal.timeout(t.timeoutMs),
			});
			check(await r.text, "no AI SDK stream");
		});
		add(
			"client.ai-messages.tool-round-trip",
			"tools",
			"sdk",
			"vercel-ai",
			async () => {
				const r = await generateText({
					...aiOpts,
					abortSignal: AbortSignal.timeout(t.timeoutMs),
					messages: [
						{
							role: "user",
							content: "Call weather for Berlin and report the temperature.",
						},
					],
					tools: {
						weather: tool({
							description: "Get weather",
							inputSchema: weatherSchema,
							execute: async () => ({ temperature: 17 }),
						}),
					},
					stopWhen: stepCountIs(3),
				});
				if (!r.text.includes("17")) throw new BehavioralFailure();
			},
		);
	}
	if (config.protocol !== "responses") {
		// LangChain provider packages are real clients; no response normalization is applied.
		const model =
			config.protocol === "messages"
				? new ChatAnthropic({
						model: t.model,
						apiKey: t.apiKey,
						clientOptions: {
							baseURL: t.baseUrl.replace(/\/v1$/, ""),
							timeout: t.timeoutMs,
						},
						maxRetries: 0,
						maxTokens: config.maxOutputTokens,
					})
				: new ChatOpenAI({
						model: t.model,
						apiKey: t.apiKey,
						configuration: { baseURL: t.baseUrl },
						maxRetries: 0,
						maxTokens: config.maxOutputTokens,
						timeout: t.timeoutMs,
					});
		add("client.langchain.invoke", "text", "sdk", "langchain", async () => {
			const r = await model.invoke(prompt);
			check(r.content.length > 0, "empty LangChain message");
		});
		add("client.langchain.stream", "stream", "sdk", "langchain", async () => {
			let content = "";
			for await (const c of await model.stream(prompt)) {
				if (typeof c.content === "string") content += c.content;
			}
			check(content.length > 0, "empty LangChain stream");
		});
		add(
			"client.langchain.structured",
			"structured-output",
			"sdk",
			"langchain",
			async () => {
				const r = await model
					.withStructuredOutput(citySchema)
					.invoke("Name the city Berlin and its country.");
				check(citySchema.safeParse(r).success, "invalid structured output");
			},
		);
		add(
			"client.langchain.tool-round-trip",
			"tools",
			"sdk",
			"langchain",
			async () => {
				const bound = model.bindTools(
					[
						{
							name: "weather",
							description: "Get the weather for a city",
							schema: weatherSchema,
						},
					],
					{ tool_choice: "weather" },
				);
				const user = new HumanMessage(
					"Get the weather in Berlin using the weather tool.",
				);
				const first = await bound.invoke([user]);
				const call = first.tool_calls?.[0];
				check(
					call?.name === "weather" &&
						weatherSchema.safeParse(call.args).success,
					"invalid LangChain tool",
				);
				check(call.id, "missing tool call ID");
				const final = await model.invoke([
					user,
					first,
					new ToolMessage({
						tool_call_id: call.id,
						content: '{"temperature":17}',
					}),
				]);
				if (!JSON.stringify(final.content).includes("17"))
					throw new BehavioralFailure();
			},
		);
	}
	// A deliberate invalid-key request validates error handling, excluded from reliability denominators.
	add(
		`${config.protocol}.invalid-key`,
		"errors",
		"wire",
		null,
		async () => {
			let status: number;
			if (config.protocol === "messages") {
				const r = await fetch(`${t.baseUrl}/messages`, {
					method: "POST",
					headers: {
						"x-api-key": "benchmark-invalid-key",
						"anthropic-version": "2023-06-01",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: t.model,
						max_tokens: 1,
						messages: [{ role: "user", content: prompt }],
					}),
				});
				status = r.status;
			} else {
				status = (
					await post(
						{ ...t, apiKey: "benchmark-invalid-key" },
						config.protocol === "responses"
							? "/responses"
							: "/chat/completions",
						config.protocol === "responses"
							? { input: prompt, max_output_tokens: 1 }
							: {
									messages: [{ role: "user", content: prompt }],
									max_tokens: 1,
								},
					)
				).status;
			}
			check(status === 401 || status === 403, "invalid key not refused");
		},
		"negative",
	);
	return selected;
}
