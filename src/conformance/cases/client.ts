import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	generateText,
	type LanguageModel,
	type ModelMessage,
	Output,
	stepCountIs,
	streamText,
	type ToolSet,
	tool,
} from "ai";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { codeWord, fixtures } from "../fixtures.ts";
import type { Target } from "../http.ts";
import {
	type Case,
	check,
	Failure,
	featureOf,
	isIdentifier,
	shape,
} from "../suite.ts";
import {
	askCity,
	askCodeWord,
	askColour,
	askJourneyThenWeather,
	askOk,
	askWeather,
	checkArgs,
	city,
	mentions,
	weather,
	weatherArgs,
	weatherResult,
} from "./common.ts";

/**
 * The client layer (.plans/2026-10-30-gateway-conformance.md, "Client
 * layer", decision 12): a subset of the wire prompts through the clients
 * applications use, against the same base URL, key and model, asserting
 * what the client returns. A router can answer a shape that passes the
 * wire checks and still break a client ("No output generated", a type
 * validation error, a stream without a finish reason); these cases catch
 * that. Retries are off, as in the wire layer.
 */

/** A client error as the suite's reason (exported for the unit tests): its name (an identifier) and status; the message is detail only. */
export function clientFailure(error: unknown): Failure {
	if (error instanceof Failure) return error;
	const name = error instanceof Error ? error.name : "";
	const status =
		(error as { statusCode?: unknown; status?: unknown })?.statusCode ??
		(error as { status?: unknown })?.status;
	const named = isIdentifier(name) ? name : "client error";
	return new Failure(
		`${named}${typeof status === "number" ? ` (HTTP ${status})` : ""}`,
		error instanceof Error ? error.message : String(error),
	);
}

const client = (
	id: string,
	needs: string[],
	run: (target: Target) => Promise<void>,
): Case => ({
	id,
	feature: featureOf(id),
	needs,
	run: (target) =>
		run(target).catch((error) => Promise.reject(clientFailure(error))),
});

// --- AI SDK -----------------------------------------------------------------

const chatModel = (target: Target): LanguageModel =>
	createOpenAICompatible({
		name: "target",
		baseURL: target.baseUrl,
		apiKey: target.apiKey,
		includeUsage: true,
		supportsStructuredOutputs: true,
	})(target.model);

const responsesModel = (target: Target): LanguageModel =>
	createOpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey }).responses(
		target.model,
	);

/** A stateless router keeps nothing, so the Responses client must not refer to stored items. */
const stateless = { openai: { store: false } };

const settings = (target: Target) => ({
	maxRetries: 0,
	abortSignal: AbortSignal.timeout(target.timeoutMs),
});

/** The tool as the AI SDK declares it; with `answer`, the SDK runs it and continues. */
const weatherTool = (answer?: boolean): ToolSet => ({
	[weather.name]: answer
		? tool({
				description: weather.description,
				inputSchema: weatherArgs,
				execute: async () => JSON.parse(weatherResult) as unknown,
			})
		: tool({ description: weather.description, inputSchema: weatherArgs }),
});

type Outcome = {
	text: string;
	finishReason: string;
	usage: {
		inputTokens: number | undefined;
		outputTokens: number | undefined;
		outputTokenDetails?: { reasoningTokens: number | undefined };
	};
	toolCalls: { toolName: string; input: unknown; invalid?: boolean }[];
};

/** What every answer the client returns must have: a finish reason it knows and usage. */
function checkOutcome(outcome: Outcome, finish: string) {
	check(
		outcome.finishReason === finish,
		`finishReason is ${outcome.finishReason}, not ${finish}`,
	);
	check((outcome.usage.inputTokens ?? 0) > 0, "usage has no input tokens");
	check(
		typeof outcome.usage.outputTokens === "number",
		"usage has no output tokens",
	);
}

function checkToolCall(outcome: Outcome) {
	const call = outcome.toolCalls[0];
	check(call, "no tool call");
	check(!call.invalid, "the client rejected the tool call's input");
	check(call.toolName === weather.name, "wrong tool called");
	shape(call.input, weatherArgs, "tool input");
	checkOutcome(outcome, "tool-calls");
}

type Call = {
	model: LanguageModel;
	temperature?: number;
	messages: ModelMessage[];
	tools?: ToolSet;
	providerOptions?: Record<
		string,
		Record<string, never | string | boolean | string[]>
	>;
};

const ask = (text: string): ModelMessage[] => [{ role: "user", content: text }];
const withFile = (
	text: string,
	data: string,
	mediaType: string,
): ModelMessage[] => [
	{
		role: "user",
		content: [
			{ type: "text", text },
			{
				type: "file",
				data: Buffer.from(data.split(",")[1] ?? "", "base64"),
				mediaType,
				filename: mediaType === "application/pdf" ? "fixture.pdf" : undefined,
			},
		],
	},
];

async function generate(target: Target, call: Call): Promise<Outcome> {
	const result = await generateText({
		...call,
		...settings(target),
		stopWhen: stepCountIs(3),
	});
	// The result's fields are getters, so they are read one by one rather than spread.
	const { text, finishReason, totalUsage: usage, toolCalls } = result;
	return { text, finishReason, usage, toolCalls };
}

/** Streams to the end; an error the stream reported wins over the "no output" error that follows it. */
async function stream(target: Target, call: Call): Promise<Outcome> {
	let failure: unknown;
	const result = streamText({
		...call,
		...settings(target),
		stopWhen: stepCountIs(3),
		onError: ({ error }) => {
			failure ??= error;
		},
	});
	const [text, finishReason, usage, toolCalls] = await Promise.all([
		result.text,
		result.finishReason,
		result.totalUsage,
		result.toolCalls,
	]).catch((error) => Promise.reject(failure ?? error));
	if (failure) throw failure;
	return { text, finishReason, usage, toolCalls };
}

/** The same cases for the chat model and the Responses model. */
function aiSdkCases(
	group: string,
	model: (target: Target) => LanguageModel,
	options?: Call["providerOptions"],
): Case[] {
	const call = (
		target: Target,
		messages: ModelMessage[],
		tools?: ToolSet,
	): Call => ({
		model: model(target),
		messages,
		tools,
		providerOptions: options,
	});
	return [
		client(`${group}.generate`, [], async (target) => {
			const outcome = await generate(target, call(target, ask(askOk)));
			check(outcome.text, "no text");
			checkOutcome(outcome, "stop");
		}),
		client(`${group}.stream`, [], async (target) => {
			const outcome = await stream(target, call(target, ask(askOk)));
			check(outcome.text, "no text in the stream");
			checkOutcome(outcome, "stop");
		}),
		client(`${group}.tool-call`, ["tools"], async (target) => {
			checkToolCall(
				await generate(target, call(target, ask(askWeather), weatherTool())),
			);
		}),
		client(`${group}.stream-tool-call`, ["tools"], async (target) => {
			checkToolCall(
				await stream(target, call(target, ask(askWeather), weatherTool())),
			);
		}),
		client(`${group}.tool-round-trip`, ["tools"], async (target) => {
			const outcome = await generate(
				target,
				call(target, ask(askWeather), weatherTool(true)),
			);
			mentions(outcome.text, "17", "answer after the tool ran");
			checkOutcome(outcome, "stop");
		}),
		client(`${group}.object`, ["structured_outputs"], async (target) => {
			const result = await generateText({
				...call(target, ask(askCity)),
				...settings(target),
				output: Output.object({ schema: city, name: "city" }),
			});
			shape(result.output, city, "object");
		}),
		client(`${group}.image`, ["image"], async (target) => {
			const outcome = await generate(target, {
				...call(target, withFile(askColour, fixtures.redSquare, "image/png")),
				temperature: target.deterministicImages ? 0 : undefined,
			});
			mentions(outcome.text, "red", "answer");
		}),
		client(`${group}.pdf`, ["file"], async (target) => {
			const outcome = await generate(
				target,
				call(target, withFile(askCodeWord, fixtures.pdf, "application/pdf")),
			);
			mentions(outcome.text, codeWord, "answer");
		}),
	];
}

// --- openai-node ------------------------------------------------------------

const openai = (target: Target) =>
	new OpenAI({
		baseURL: target.baseUrl,
		apiKey: target.apiKey,
		maxRetries: 0,
		timeout: target.timeoutMs,
	});

export const clientCases: Case[] = [
	...aiSdkCases("client.ai-chat", chatModel),
	...aiSdkCases("client.ai-responses", responsesModel, stateless),
	client(
		"client.ai-responses.reasoning-round-trip",
		["encrypted_reasoning", "reasoning_tokens", "tools"],
		async (target) => {
			// The client replays the encrypted reasoning with the tool result, as a stateless router needs.
			const outcome = await generate(target, {
				model: responsesModel(target),
				messages: ask(askJourneyThenWeather),
				tools: weatherTool(true),
				providerOptions: {
					openai: {
						...stateless.openai,
						forceReasoning: true,
						reasoningEffort: target.reasoningEffort ?? "medium",
						reasoningSummary: "auto",
						include: ["reasoning.encrypted_content"],
					},
				},
			});
			mentions(outcome.text, "17", "answer after the tool ran");
			checkOutcome(outcome, "stop");
			const reasoning = outcome.usage.outputTokenDetails?.reasoningTokens;
			check((reasoning ?? 0) > 0, "usage has no reasoning tokens");
		},
	),
	client("client.openai-chat.stream-tool-call", ["tools"], async (target) => {
		const final = await openai(target)
			.chat.completions.stream({
				model: target.model,
				messages: [{ role: "user", content: askWeather }],
				tools: [{ type: "function", function: weather }],
				stream_options: { include_usage: true },
			})
			.finalChatCompletion();
		const choice = final.choices[0];
		const call = choice?.message.tool_calls?.[0];
		check(call?.type === "function", "no function tool call");
		check(call.function.name === weather.name, "wrong tool called");
		checkArgs(call.function.arguments, weatherArgs);
		check(
			choice?.finish_reason === "tool_calls",
			"finish_reason is not tool_calls",
		);
		check(final.usage, "no usage in the final completion");
	}),
	client("client.openai-chat.parse", ["structured_outputs"], async (target) => {
		const final = await openai(target).chat.completions.parse({
			model: target.model,
			messages: [{ role: "user", content: askCity }],
			response_format: zodResponseFormat(city, "city"),
		});
		shape(final.choices[0]?.message.parsed, city, "parsed content");
	}),
	client("client.openai-responses.stream", [], async (target) => {
		const final = await openai(target)
			.responses.stream({ model: target.model, input: askOk, store: false })
			.finalResponse();
		check(final.status === "completed", "status is not completed");
		check(final.output_text, "no output_text");
		check(final.usage, "no usage in the final response");
	}),
	client(
		"client.openai-responses.stream-tool-call",
		["tools"],
		async (target) => {
			const final = await openai(target)
				.responses.stream({
					model: target.model,
					input: askWeather,
					tools: [{ type: "function", ...weather, strict: null }],
					store: false,
				})
				.finalResponse();
			const call = final.output.find((item) => item.type === "function_call");
			check(call, "no function_call item");
			check(call.name === weather.name, "wrong tool called");
			checkArgs(call.arguments, weatherArgs);
			check(final.usage, "no usage in the final response");
		},
	),
];
