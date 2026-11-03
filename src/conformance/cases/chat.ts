import {
	codeWord,
	fixtures,
	helloPdfUrl,
	helloPdfWord,
	redSquareRedirectUrl,
	redSquareSignedUrl,
	redSquareUrl,
} from "../fixtures.ts";
import { type Json, post, postStream, type Target } from "../http.ts";
import {
	type ChatStream,
	type Completion,
	chatStream,
	checkChatUsage,
	completion,
} from "../shapes.ts";
import {
	type Case,
	check,
	checkRefused,
	Failure,
	featureOf,
	json,
	ok,
	okStream,
	servedOrRefused,
	shape,
} from "../suite.ts";
import {
	askCity,
	askCityNickname,
	askCodeWord,
	askColour,
	askFolder,
	askFruit,
	askJourney,
	askNotes,
	askOk,
	askPdfLine,
	askSky,
	askTwoCities,
	askWeather,
	askWeatherNoTool,
	cachePrefix,
	checkArgs,
	checkModel,
	checkNotes,
	checkSky,
	city,
	cityFormat,
	cityNickname,
	foreignCallId,
	fruit,
	fruitFact,
	journeyMinutes,
	jsonFixtureTokens,
	mentions,
	nicknameFormat,
	notesFormat,
	samplingParams,
	skyFormat,
	time,
	weather,
	weatherArgs,
	weatherResult,
} from "./common.ts";

/**
 * Chat Completions cases, one feature of the plan's matrix
 * (.plans/2026-10-30-gateway-conformance.md) per group.
 */

const path = "/chat/completions";

async function chat(target: Target, body: Json): Promise<Completion> {
	const answer = await post(target, path, body);
	const value = ok(answer, completion, "completion");
	checkChatUsage(value.usage);
	return value;
}

async function stream(target: Target, body: Json): Promise<ChatStream> {
	return chatStream(okStream(await postStream(target, path, body)).events);
}

const user = (content: unknown) => [{ role: "user", content }];
const first = (value: Pick<Completion, "choices">) =>
	value.choices[0] as Completion["choices"][number];
const tools = (...fns: (typeof weather)[]) =>
	fns.map((fn) => ({ type: "function", function: fn }));

/** A case that only checks a parameter is accepted and the answer keeps its shape. */
const accepted = (id: string, params: Json, needs: string[] = []): Case => ({
	id,
	feature: featureOf(id),
	needs,
	run: async (target) => {
		await chat(target, { messages: user(askOk), ...params });
	},
});

/**
 * A parameter the model lists must work; one it does not list (E20) may be
 * dropped or refused with a 4xx, never answered with a 5xx, which one
 * upstream did for sampling and reasoning parameters it does not take.
 */
const sampling = [
	...samplingParams.map(([name, params]) =>
		accepted(`chat.sampling.${name}`, params, [name]),
	),
	...[
		...samplingParams,
		["reasoning", { reasoning: { effort: "low" } }] as const,
	].map(
		([name, params]): Case => ({
			id:
				name === "reasoning"
					? "chat.reasoning.unlisted"
					: `chat.sampling.${name}-unlisted`,
			feature: name === "reasoning" ? "chat.reasoning" : "chat.sampling",
			lacks: [name],
			run: async (target) => {
				const answer = await post(target, path, {
					messages: user(askOk),
					...params,
				});
				await servedOrRefused(answer, completion, "completion", (value) =>
					checkChatUsage(value.usage),
				);
			},
		}),
	),
];

/** A case where the model must name what one image or file part shows. */
const reads = (
	id: string,
	needs: string,
	ask: string,
	part: Json,
	word: string,
): Case => ({
	id,
	feature: featureOf(id),
	needs: [needs],
	run: async (target) => {
		const value = await chat(target, {
			messages: user([{ type: "text", text: ask }, part]),
			...(target.deterministicImages ? { temperature: 0 } : {}),
		});
		mentions(first(value).message.content, word, "answer");
	},
});
const image = (url: string) => ({ type: "image_url", image_url: { url } });
const file = (data: string) => ({
	type: "file",
	file: { filename: "fixture.pdf", file_data: data },
});

/** A structured output case a server may serve (and then must validate) or refuse with a 4xx. */
const formatServedOrRefused = (
	id: string,
	ask: string,
	format: Json,
	validate: (value: unknown, what: string) => void,
): Case => ({
	id,
	feature: "chat.json-schema",
	needs: ["structured_outputs"],
	run: async (target) => {
		const answer = await post(target, path, {
			messages: user(ask),
			max_tokens: jsonFixtureTokens,
			...(target.jsonFixtureEffort
				? { reasoning: { effort: target.jsonFixtureEffort } }
				: {}),
			response_format: { type: "json_schema", json_schema: format },
		});
		await servedOrRefused(answer, completion, "completion", (value) => {
			checkChatUsage(value.usage);
			validate(json(first(value).message.content, "content"), "content");
		});
	},
});

/** A request with history that ends in a tool result, answered with the result's temperature. */
const toolResult = (
	id: string,
	callId: string,
	content: string | null,
): Case => ({
	id,
	feature: "chat.tools",
	needs: ["tools"],
	run: async (target) => {
		const value = await chat(target, {
			messages: [
				{ role: "user", content: askWeather },
				{
					role: "assistant",
					content,
					tool_calls: [
						{
							id: callId,
							type: "function",
							function: {
								name: weather.name,
								arguments: JSON.stringify({ city: "Berlin" }),
							},
						},
					],
				},
				{ role: "tool", tool_call_id: callId, content: weatherResult },
			],
			tools: tools(weather),
		});
		check(
			!first(value).message.tool_calls?.length,
			"answered with another tool call",
		);
		mentions(first(value).message.content, "17", "answer");
	},
});

/** The caching case: a long system prefix sent twice and more, until a repeat reports cached tokens. */
const caching = (id: string, system: Json): Case => ({
	id,
	feature: "chat.caching",
	needs: ["caching"],
	run: async (target) => {
		const body = { messages: [system, { role: "user", content: askFolder }] };
		await chat(target, body);
		// Caching is best-effort and a router may send a request to another replica: try thrice.
		for (let attempt = 0; attempt < 3; attempt++) {
			const cached = (await chat(target, body)).usage.prompt_tokens_details
				?.cached_tokens;
			if (typeof cached === "number" && cached > 0) return;
		}
		throw new Failure("no repeat of the request reports cached_tokens");
	},
});

export const chatCases: Case[] = [
	{
		id: "chat.basic.shape",
		feature: "chat.basic",
		run: async (target) => {
			const value = await chat(target, { messages: user(askOk) });
			check(first(value).message.content, "message has no content");
			check(
				first(value).finish_reason === "stop",
				`finish_reason is ${first(value).finish_reason}`,
			);
		},
	},
	{
		id: "chat.basic.model",
		feature: "chat.basic",
		run: async (target) => {
			checkModel(
				(await chat(target, { messages: user(askOk) })).model,
				target.model,
			);
		},
	},
	{
		id: "chat.messages.system",
		feature: "chat.messages",
		run: async (target) => {
			const value = await chat(target, {
				messages: [
					{ role: "system", content: fruitFact },
					{ role: "user", content: askFruit },
				],
			});
			mentions(first(value).message.content, fruit, "answer");
		},
	},
	{
		id: "chat.messages.developer",
		feature: "chat.messages",
		run: async (target) => {
			const value = await chat(target, {
				messages: [
					{
						role: "developer",
						content: fruitFact,
					},
					{ role: "user", content: askFruit },
				],
			});
			mentions(first(value).message.content, fruit, "answer");
		},
	},
	{
		id: "chat.messages.multi-turn",
		feature: "chat.messages",
		run: async (target) => {
			const value = await chat(target, {
				messages: [
					{ role: "user", content: "Remember the word ZEPPELIN." },
					{ role: "assistant", content: "I will remember it." },
					{
						role: "user",
						content:
							"Which word did I ask you to remember? Answer with the word only.",
					},
				],
			});
			mentions(first(value).message.content, "zeppelin", "answer");
		},
	},
	{
		id: "chat.stream.shape",
		feature: "chat.stream",
		run: async (target) => {
			const streamed = okStream(
				await postStream(target, path, { messages: user(askOk) }),
			);
			check(
				streamed.headers.get("content-type")?.includes("text/event-stream"),
				"content-type is not text/event-stream",
			);
			const { chunks, assembled } = chatStream(streamed.events);
			check(
				chunks[0]?.choices[0]?.delta.role === "assistant",
				"first delta has no assistant role",
			);
			check(first(assembled).message.content, "stream carries no content");
		},
	},
	{
		id: "chat.stream.matches-whole",
		feature: "chat.stream",
		run: async (target) => {
			const body = { messages: user(askOk) };
			const [whole, { assembled }] = await Promise.all([
				chat(target, body),
				stream(target, body),
			]);
			check(
				first(assembled).finish_reason === first(whole).finish_reason,
				"streamed and whole finish reasons differ",
			);
			check(
				typeof first(assembled).message.content ===
					typeof first(whole).message.content,
				"streamed and whole content differ in type",
			);
		},
	},
	{
		id: "chat.stream-usage.include",
		feature: "chat.stream-usage",
		run: async (target) => {
			const { chunks, usageAt, assembled } = await stream(target, {
				messages: user(askOk),
				stream_options: { include_usage: true },
			});
			check(usageAt !== -1, "no chunk carries usage");
			check(
				usageAt === chunks.length - 1,
				"the usage chunk is not the last before [DONE]",
			);
			check(assembled.usage, "no usage in the stream");
			checkChatUsage(assembled.usage);
		},
	},
	{
		id: "chat.tools.call",
		feature: "chat.tools",
		needs: ["tools"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askWeather),
				tools: tools(weather),
			});
			const call = first(value).message.tool_calls?.[0];
			check(call, "no tool call");
			check(call.function.name === weather.name, "wrong tool called");
			checkArgs(call.function.arguments, weatherArgs);
			check(
				first(value).finish_reason === "tool_calls",
				`finish_reason is ${first(value).finish_reason}`,
			);
		},
	},
	// One upstream refused `content: null` beside tool calls (E9); another refuses ids it did not write (E8).
	toolResult("chat.tools.result", "call_weather_1", null),
	toolResult("chat.tools.result-empty-content", "call_weather_1", ""),
	toolResult("chat.tools.foreign-id", foreignCallId, null),
	...[
		{
			id: "chat.tool-choice.required-unavailable",
			needs: ["tools"],
			lacks: ["tool_choice_required"],
			body: {
				messages: user("Hello!"),
				tools: tools(weather),
				tool_choice: "required",
			},
		},
		{
			id: "chat.tool-choice.named-unavailable",
			needs: ["tools"],
			lacks: ["tool_choice"],
			body: {
				messages: user("Hello!"),
				tools: tools(weather),
				tool_choice: { type: "function", function: { name: weather.name } },
			},
		},
		{
			id: "chat.json-schema.unavailable",
			needs: [],
			lacks: ["structured_outputs"],
			body: {
				messages: user("Hello!"),
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "test",
						strict: true,
						schema: {
							type: "object",
							properties: { answer: { type: "string" } },
							required: ["answer"],
							additionalProperties: false,
						},
					},
				},
			},
		},
		{
			id: "chat.json-schema.optional-unavailable",
			needs: ["structured_outputs"],
			lacks: ["json_schema_optional"],
			body: {
				messages: user("Hello!"),
				response_format: {
					type: "json_schema",
					json_schema: nicknameFormat(false),
				},
			},
		},
		{
			id: "chat.json-schema.unconstrained-unavailable",
			needs: ["structured_outputs"],
			lacks: ["json_schema_unconstrained"],
			body: {
				messages: user("Hello!"),
				response_format: { type: "json_schema", json_schema: notesFormat },
			},
		},
	].map(
		({ id, needs, lacks, body }): Case => ({
			id,
			feature: featureOf(id),
			needs,
			lacks,
			run: async (target) => checkRefused(await post(target, path, body)),
		}),
	),

	{
		id: "chat.tool-choice.required",
		feature: "chat.tool-choice",
		needs: ["tools", "tool_choice_required"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user("Hello!"),
				tools: tools(weather),
				tool_choice: "required",
				...(target.toolChoiceEffort
					? { reasoning: { effort: target.toolChoiceEffort } }
					: {}),
			});
			check(first(value).message.tool_calls?.length, "no tool call");
		},
	},
	{
		id: "chat.tool-choice.named",
		feature: "chat.tool-choice",
		needs: ["tools", "tool_choice"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askWeather),
				tools: tools(weather, time),
				tool_choice: { type: "function", function: { name: time.name } },
			});
			const calls = first(value).message.tool_calls ?? [];
			// The named call comes first; a model may add parallel calls after it (Claude does).
			check(
				calls[0]?.function.name === time.name,
				"the first tool call is not the named one",
			);
		},
	},
	{
		id: "chat.tool-choice.none",
		feature: "chat.tool-choice",
		needs: ["tools", "tool_choice"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askWeatherNoTool),
				tools: tools(weather),
				tool_choice: "none",
			});
			// No content check: some models end the turn empty when they may not call the tool.
			check(
				!first(value).message.tool_calls?.length,
				"called a tool despite tool_choice none",
			);
			check(
				first(value).finish_reason === "stop",
				`finish_reason is ${first(value).finish_reason}`,
			);
		},
	},
	{
		id: "chat.parallel-tools.two-calls",
		feature: "chat.parallel-tools",
		needs: ["tools", "parallel_tool_calls"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askTwoCities),
				tools: tools(weather),
				parallel_tool_calls: true,
			});
			const calls = first(value).message.tool_calls ?? [];
			check(calls.length >= 2, `${calls.length} tool calls, not 2`);
			check(
				new Set(calls.map((call) => call.id)).size === calls.length,
				"tool call ids repeat",
			);
			for (const call of calls) checkArgs(call.function.arguments, weatherArgs);
		},
	},
	{
		id: "chat.stream-tools.call",
		feature: "chat.stream-tools",
		needs: ["tools"],
		run: async (target) => {
			const { assembled } = await stream(target, {
				messages: user(askWeather),
				tools: tools(weather),
				stream_options: { include_usage: true },
			});
			const call = first(assembled).message.tool_calls?.[0];
			check(call, "no tool call in the stream");
			// Usage is never missing, with tools as without (E23).
			check(assembled.usage, "no usage in the stream");
			checkChatUsage(assembled.usage);
			check(call.function.name === weather.name, "wrong tool called");
			checkArgs(call.function.arguments, weatherArgs);
			check(
				first(assembled).finish_reason === "tool_calls",
				"finish_reason is not tool_calls",
			);
		},
	},
	{
		id: "chat.json-object.object",
		feature: "chat.json-object",
		needs: ["response_format"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(`${askCity} Answer with a JSON object only.`),
				max_tokens: jsonFixtureTokens,
				...(target.jsonFixtureEffort
					? { reasoning: { effort: target.jsonFixtureEffort } }
					: {}),
				response_format: { type: "json_object" },
			});
			const parsed = json(first(value).message.content, "content");
			check(
				parsed && typeof parsed === "object" && !Array.isArray(parsed),
				"content is not a JSON object",
			);
		},
	},
	{
		id: "chat.json-schema.strict",
		feature: "chat.json-schema",
		needs: ["structured_outputs"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askCity),
				max_tokens: jsonFixtureTokens,
				...(target.jsonFixtureEffort
					? { reasoning: { effort: target.jsonFixtureEffort } }
					: {}),
				response_format: { type: "json_schema", json_schema: cityFormat },
			});
			shape(json(first(value).message.content, "content"), city, "content");
		},
	},
	{
		id: "chat.json-schema.stream",
		feature: "chat.json-schema",
		needs: ["structured_outputs"],
		run: async (target) => {
			const { assembled } = await stream(target, {
				messages: user(askCity),
				max_tokens: jsonFixtureTokens,
				...(target.jsonFixtureEffort
					? { reasoning: { effort: target.jsonFixtureEffort } }
					: {}),
				response_format: { type: "json_schema", json_schema: cityFormat },
			});
			shape(
				json(first(assembled).message.content, "streamed content"),
				city,
				"streamed content",
			);
		},
	},
	{
		id: "chat.json-schema.non-strict",
		feature: "chat.json-schema",
		needs: ["structured_outputs", "json_schema_optional"],
		run: async (target) => {
			// One upstream applied strict-mode rules to `strict: false` and refused the optional property.
			const value = await chat(target, {
				messages: user(askCityNickname),
				max_tokens: jsonFixtureTokens,
				...(target.jsonFixtureEffort
					? { reasoning: { effort: target.jsonFixtureEffort } }
					: {}),
				response_format: {
					type: "json_schema",
					json_schema: nicknameFormat(false),
				},
			});
			shape(
				json(first(value).message.content, "content"),
				cityNickname,
				"content",
			);
		},
	},
	formatServedOrRefused(
		"chat.json-schema.strict-optional",
		askCityNickname,
		nicknameFormat(true),
		(value, what) => shape(value, cityNickname, what),
	),
	formatServedOrRefused(
		"chat.json-schema.keyword-not",
		askSky,
		skyFormat,
		checkSky,
	),
	formatServedOrRefused(
		"chat.json-schema.empty-schema",
		askNotes,
		notesFormat,
		checkNotes,
	),
	{
		id: "chat.reasoning.tokens",
		feature: "chat.reasoning",
		needs: ["reasoning_tokens"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askJourney),
				reasoning: { effort: target.reasoningEffort ?? "medium" },
			});
			const reasoning = value.usage.completion_tokens_details?.reasoning_tokens;
			check(
				typeof reasoning === "number" && reasoning > 0,
				"no reasoning_tokens in usage",
			);
			mentions(first(value).message.content, journeyMinutes, "answer");
		},
	},
	{
		id: "chat.reasoning.effort-flat",
		feature: "chat.reasoning",
		needs: ["reasoning"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askJourney),
				reasoning_effort: target.reasoningEffort ?? "medium",
			});
			mentions(first(value).message.content, journeyMinutes, "answer");
		},
	},
	{
		id: "chat.reasoning.exclude",
		feature: "chat.reasoning",
		needs: ["reasoning"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askJourney),
				reasoning: {
					effort: target.reasoningEffort ?? "medium",
					exclude: true,
				},
			});
			check(
				!first(value).message.reasoning,
				"reasoning text returned despite exclude",
			);
		},
	},
	{
		id: "chat.reasoning.stream",
		feature: "chat.reasoning",
		needs: ["reasoning_tokens"],
		run: async (target) => {
			const { assembled } = await stream(target, {
				messages: user(askJourney),
				reasoning: { effort: target.reasoningEffort ?? "medium" },
				stream_options: { include_usage: true },
			});
			const reasoning =
				assembled.usage?.completion_tokens_details?.reasoning_tokens;
			check(
				typeof reasoning === "number" && reasoning > 0,
				"no reasoning_tokens in the stream's usage",
			);
			mentions(
				first(assembled).message.content,
				journeyMinutes,
				"streamed answer",
			);
		},
	},
	{
		id: "chat.images.remote-unavailable",
		feature: "chat.images",
		needs: ["image"],
		lacks: ["image_url"],
		run: async (target) =>
			checkRefused(
				await post(target, path, {
					messages: user([
						{ type: "text", text: askColour },
						image(redSquareUrl),
					]),
				}),
			),
	},
	reads("chat.images.url", "image_url", askColour, image(redSquareUrl), "red"),
	reads(
		"chat.images.base64",
		"image",
		askColour,
		image(fixtures.redSquare),
		"red",
	),
	// A fetcher that drops a presigned query or gives up on redirects fails these (E4).
	reads(
		"chat.images.url-query",
		"image_url",
		askColour,
		image(redSquareSignedUrl),
		"red",
	),
	reads(
		"chat.images.url-redirect",
		"image_url",
		askColour,
		image(redSquareRedirectUrl),
		"red",
	),
	{
		id: "chat.images.mime-mismatch",
		feature: "chat.images",
		needs: ["image"],
		run: async (target) => {
			const answer = await post(target, path, {
				messages: user([
					{ type: "text", text: askColour },
					image(fixtures.jpegAsPng),
				]),
			});
			await servedOrRefused(answer, completion, "completion", (value) =>
				mentions(first(value).message.content, "red", "answer"),
			);
		},
	},
	{
		id: "chat.images.unsupported",
		feature: "chat.images",
		lacks: ["image"],
		run: async (target) => {
			// A text-only model must refuse the image, not answer without it (E19).
			const answer = await post(target, path, {
				messages: user([
					{ type: "text", text: askColour },
					image(fixtures.redSquare),
				]),
			});
			if (answer.status !== 200) return checkRefused(answer);
			const value = shape(answer.body, completion, "completion");
			mentions(
				first(value).message.content,
				"red",
				"an answer to an image the model cannot see",
			);
		},
	},
	reads("chat.pdf.base64", "file", askCodeWord, file(fixtures.pdf), codeWord),
	reads("chat.pdf.url", "file", askPdfLine, file(helloPdfUrl), helloPdfWord),
	{
		id: "chat.pdf.corrupt",
		feature: "chat.pdf",
		needs: ["file"],
		run: async (target) => {
			const answer = await post(target, path, {
				messages: user([
					{ type: "text", text: askCodeWord },
					file(fixtures.corruptPdf),
				]),
			});
			await servedOrRefused(answer, completion, "completion", (value) =>
				checkChatUsage(value.usage),
			);
		},
	},
	{
		id: "chat.audio.wav",
		feature: "chat.audio",
		needs: ["audio"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user([
					{ type: "text", text: "Describe this audio clip in one sentence." },
					{
						type: "input_audio",
						input_audio: { data: fixtures.toneWav, format: "wav" },
					},
				]),
			});
			check(first(value).message.content, "message has no content");
		},
	},
	caching("chat.caching.cached-tokens", {
		role: "system",
		content: [
			{ type: "text", text: cachePrefix, cache_control: { type: "ephemeral" } },
		],
	}),
	// The message-level form on string content, which one router dropped silently (E22).
	caching("chat.caching.message-level", {
		role: "system",
		content: cachePrefix,
		cache_control: { type: "ephemeral" },
	}),
	{
		id: "chat.logprobs.top",
		feature: "chat.logprobs",
		needs: ["logprobs", "top_logprobs"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user(askOk),
				logprobs: true,
				top_logprobs: 2,
			});
			const tokens = first(value).logprobs?.content;
			check(tokens?.length, "no token logprobs");
			check(
				tokens.every((token) => (token.top_logprobs?.length ?? 0) <= 2),
				"more top_logprobs than asked for",
			);
		},
	},
	accepted("chat.seed.accepted", { seed: 42 }, ["seed"]),
	{
		id: "chat.stop.sequence",
		feature: "chat.stop",
		needs: ["stop"],
		run: async (target) => {
			const value = await chat(target, {
				messages: user("Count from 1 to 10, separated by spaces, digits only."),
				stop: ["6"],
			});
			const { content, reasoning } = first(value).message;
			check(!content?.includes("6"), "answer runs past the stop sequence");
			// A reasoning model may meet the sequence while thinking and end with no answer (gpt-oss).
			if (content) mentions(content, "5", "answer");
			else
				check(reasoning, "no answer and no reasoning before the stop sequence");
			check(
				first(value).finish_reason === "stop",
				`finish_reason is ${first(value).finish_reason}`,
			);
		},
	},
	...(
		[
			["max_tokens", "chat.max-tokens.max-tokens"],
			["max_completion_tokens", "chat.max-tokens.max-completion-tokens"],
		] as const
	).map(
		([param, id]): Case => ({
			id,
			feature: "chat.max-tokens",
			needs: ["max_tokens"],
			run: async (target) => {
				const limit = 16;
				const value = await chat(target, {
					messages: user("Write a 500-word essay about rivers."),
					[param]: limit,
				});
				check(
					first(value).finish_reason === "length",
					`finish_reason is ${first(value).finish_reason}`,
				);
				check(
					value.usage.completion_tokens <= limit,
					`completion_tokens exceed ${param}`,
				);
			},
		}),
	),
	...sampling,
	accepted("chat.user-metadata.user", { user: "conformance-suite" }),
	accepted("chat.user-metadata.metadata", {
		metadata: { suite: "conformance", run: "check" },
	}),
	{
		id: "chat.prediction.content",
		feature: "chat.prediction",
		needs: ["prediction"],
		run: async (target) => {
			const code = "function add(a, b) {\n  return a + b;\n}\n";
			const value = await chat(target, {
				messages: user(
					`Rename the function to sum and reply with the code only:\n${code}`,
				),
				prediction: { type: "content", content: code.replace("add", "sum") },
			});
			mentions(first(value).message.content, "sum", "answer");
		},
	},
	accepted("chat.verbosity.low", { verbosity: "low" }, ["verbosity"]),
];
