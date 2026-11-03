import {
	codeWord,
	fixtures,
	helloPdfUrl,
	helloPdfWord,
	redSquareRedirectUrl,
	redSquareSignedUrl,
	redSquareUrl,
} from "../fixtures.ts";
import { type Json, post, postStream, request, type Target } from "../http.ts";
import {
	checkResponse,
	functionCalls,
	outputTextOf,
	type Response,
	type ResponsesStream,
	response,
	responsesStream,
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
	askFruit,
	askJourney,
	askJourneyThenWeather,
	askNotes,
	askOk,
	askPdfLine,
	askSky,
	askTwoCities,
	askWeather,
	askWeatherNoTool,
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
 * Responses API cases, one feature of the plan's matrix
 * (.plans/2026-10-30-gateway-conformance.md) per group. The basic,
 * system-prompt, multi-turn, tool-calling, image and streaming cases follow
 * the ideas of Open Responses' compliance tests
 * (github.com/openresponses/openresponses, `src/lib/compliance-tests.ts`,
 * Apache-2.0); no code is copied.
 */

const path = "/responses";

async function respond(target: Target, body: Json): Promise<Response> {
	return ok(await post(target, path, body), response, "response");
}

/** A completed response whose usage adds up. */
async function completed(target: Target, body: Json): Promise<Response> {
	const value = await respond(target, body);
	checkResponse(value);
	return value;
}

async function stream(target: Target, body: Json): Promise<ResponsesStream> {
	return responsesStream(okStream(await postStream(target, path, body)).events);
}

const userText = (text: string) => ({
	type: "message",
	role: "user",
	content: [{ type: "input_text", text }],
});

const tools = (...fns: (typeof weather)[]) =>
	fns.map((fn) => ({ type: "function", ...fn }));

/** A user message with `askText` and one more content part. */
const withPart = (askText: string, part: Json) => [
	{
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: askText }, part],
	},
];
const image = (url: string) => ({ type: "input_image", image_url: url });

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
		const value = await completed(target, {
			input: withPart(ask, part),
			...(target.deterministicImages ? { temperature: 0 } : {}),
		});
		mentions(outputTextOf(value), word, "answer");
	},
});

/** A structured output case a server may serve (and then must validate) or refuse with a 4xx. */
const formatServedOrRefused = (
	id: string,
	input: string,
	format: Json,
	validate: (value: unknown, what: string) => void,
): Case => ({
	id,
	feature: "responses.text-format",
	needs: ["structured_outputs"],
	run: async (target) => {
		const answer = await post(target, path, {
			input,
			max_output_tokens: jsonFixtureTokens,
			...(target.jsonFixtureEffort
				? { reasoning: { effort: target.jsonFixtureEffort } }
				: {}),
			text: { format: { type: "json_schema", ...format } },
		});
		await servedOrRefused(answer, response, "response", (value) => {
			checkResponse(value);
			validate(json(outputTextOf(value), "output_text"), "output_text");
		});
	},
});

/** `store: true` or a `previous_response_id`: honoured, or refused with a 400 in the error shape. */
async function honouredOrRefused(
	target: Target,
	body: Json,
	honoured: (value: Response) => Promise<void>,
) {
	const answer = await post(target, path, body);
	check(
		answer.status === 200 || answer.status === 400,
		`answered ${answer.status}, neither 200 nor 400`,
	);
	await servedOrRefused(answer, response, "response", honoured);
}

export const responsesCases: Case[] = [
	{
		id: "responses.basic.shape",
		feature: "responses.basic",
		run: async (target) => {
			const value = await completed(target, { input: askOk });
			check(
				value.output.some((item) => item.type === "message"),
				"no message item",
			);
			check(outputTextOf(value), "no output_text");
		},
	},
	{
		id: "responses.basic.model",
		feature: "responses.basic",
		run: async (target) => {
			checkModel(
				(await completed(target, { input: askOk })).model,
				target.model,
			);
		},
	},
	{
		id: "responses.input.items",
		feature: "responses.input",
		run: async (target) => {
			const value = await completed(target, { input: [userText(askOk)] });
			check(outputTextOf(value), "no output_text");
		},
	},
	{
		id: "responses.input.system",
		feature: "responses.input",
		run: async (target) => {
			const value = await completed(target, {
				input: [
					{
						type: "message",
						role: "system",
						content: fruitFact,
					},
					userText(askFruit),
				],
			});
			mentions(outputTextOf(value), fruit, "answer");
		},
	},
	{
		id: "responses.input.developer",
		feature: "responses.input",
		run: async (target) => {
			const value = await completed(target, {
				input: [
					{
						type: "message",
						role: "developer",
						content: fruitFact,
					},
					userText(askFruit),
				],
			});
			mentions(outputTextOf(value), fruit, "answer");
		},
	},
	{
		id: "responses.input.multi-turn",
		feature: "responses.input",
		run: async (target) => {
			const value = await completed(target, {
				input: [
					userText("Remember the word ZEPPELIN."),
					{
						type: "message",
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: "I will remember it.",
								annotations: [],
							},
						],
					},
					userText(
						"Which word did I ask you to remember? Answer with the word only.",
					),
				],
			});
			mentions(outputTextOf(value), "zeppelin", "answer");
		},
	},
	{
		id: "responses.instructions.followed",
		feature: "responses.instructions",
		run: async (target) => {
			const value = await completed(target, {
				instructions: fruitFact,
				input: askFruit,
			});
			mentions(outputTextOf(value), fruit, "answer");
			check(value.instructions === fruitFact, "instructions are not echoed");
		},
	},
	{
		id: "responses.stream.order",
		feature: "responses.stream",
		run: async (target) => {
			const { types, final } = await stream(target, { input: askOk });
			check(
				types.includes("response.output_text.delta"),
				"no output_text.delta events",
			);
			check(
				types.at(-1) === "response.completed",
				`stream ends with ${types.at(-1)}`,
			);
			checkResponse(final);
		},
	},
	{
		id: "responses.stream.matches-whole",
		feature: "responses.stream",
		run: async (target) => {
			const [whole, { final }] = await Promise.all([
				completed(target, { input: askOk }),
				stream(target, { input: askOk }),
			]);
			const kinds = (value: Response) =>
				value.output.map((item) => item.type).join(",");
			check(
				kinds(final) === kinds(whole),
				"streamed and whole output items differ",
			);
			check(final.status === whole.status, "streamed and whole status differ");
		},
	},
	{
		id: "responses.tools.call",
		feature: "responses.tools",
		needs: ["tools"],
		run: async (target) => {
			const value = await completed(target, {
				input: askWeather,
				tools: tools(weather),
			});
			const call = functionCalls(value)[0];
			check(call, "no function_call item");
			check(call.name === weather.name, "wrong tool called");
			checkArgs(call.arguments, weatherArgs);
		},
	},
	{
		id: "responses.tools.result",
		feature: "responses.tools",
		needs: ["tools"],
		run: async (target) => {
			const value = await completed(target, {
				input: [
					userText(askWeather),
					{
						type: "function_call",
						call_id: "call_weather_1",
						name: weather.name,
						arguments: JSON.stringify({ city: "Berlin" }),
					},
					{
						type: "function_call_output",
						call_id: "call_weather_1",
						output: weatherResult,
					},
				],
				tools: tools(weather),
			});
			check(
				functionCalls(value).length === 0,
				"answered with another function call",
			);
			mentions(outputTextOf(value), "17", "answer");
		},
	},
	{
		id: "responses.tools.foreign-id",
		feature: "responses.tools",
		needs: ["tools"],
		run: async (target) => {
			// History written by another provider, as after a model switch (E8).
			const value = await completed(target, {
				input: [
					userText(askWeather),
					{
						type: "function_call",
						call_id: foreignCallId,
						name: weather.name,
						arguments: JSON.stringify({ city: "Berlin" }),
					},
					{
						type: "function_call_output",
						call_id: foreignCallId,
						output: weatherResult,
					},
				],
				tools: tools(weather),
			});
			check(
				functionCalls(value).length === 0,
				"answered with another function call",
			);
			mentions(outputTextOf(value), "17", "answer");
		},
	},
	...[
		{
			id: "responses.tool-choice.required-unavailable",
			needs: ["tools"],
			lacks: ["tool_choice_required"],
			body: { input: "Hello!", tools: tools(weather), tool_choice: "required" },
		},
		{
			id: "responses.tool-choice.named-unavailable",
			needs: ["tools"],
			lacks: ["tool_choice"],
			body: {
				input: "Hello!",
				tools: tools(weather),
				tool_choice: { type: "function", name: weather.name },
			},
		},
		{
			id: "responses.json-schema.unavailable",
			needs: [],
			lacks: ["structured_outputs"],
			body: {
				input: "Hello!",
				text: {
					format: {
						type: "json_schema",
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
			id: "responses.json-schema.optional-unavailable",
			needs: ["structured_outputs"],
			lacks: ["json_schema_optional"],
			body: {
				input: "Hello!",
				text: { format: { type: "json_schema", ...nicknameFormat(false) } },
			},
		},
		{
			id: "responses.json-schema.unconstrained-unavailable",
			needs: ["structured_outputs"],
			lacks: ["json_schema_unconstrained"],
			body: {
				input: "Hello!",
				text: { format: { type: "json_schema", ...notesFormat } },
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
		id: "responses.tool-choice.required",
		feature: "responses.tool-choice",
		needs: ["tools", "tool_choice_required"],
		run: async (target) => {
			const value = await completed(target, {
				input: "Hello!",
				tools: tools(weather),
				tool_choice: "required",
				...(target.toolChoiceEffort
					? { reasoning: { effort: target.toolChoiceEffort } }
					: {}),
			});
			check(functionCalls(value).length > 0, "no function_call item");
		},
	},
	{
		id: "responses.tool-choice.named",
		feature: "responses.tool-choice",
		needs: ["tools", "tool_choice"],
		run: async (target) => {
			const value = await completed(target, {
				input: askWeather,
				tools: tools(weather, time),
				tool_choice: { type: "function", name: time.name },
			});
			const calls = functionCalls(value);
			// The named call comes first; a model may add parallel calls after it (Claude does).
			check(
				calls[0]?.name === time.name,
				"the first function call is not the named one",
			);
		},
	},
	{
		id: "responses.tool-choice.none",
		feature: "responses.tool-choice",
		needs: ["tools", "tool_choice"],
		run: async (target) => {
			// Not `completed`: some models end the turn empty when they may not call the tool.
			const value = await respond(target, {
				input: askWeatherNoTool,
				tools: tools(weather),
				tool_choice: "none",
			});
			check(
				value.status === "completed",
				`status is ${value.status}, not completed`,
			);
			check(
				functionCalls(value).length === 0,
				"called a tool despite tool_choice none",
			);
		},
	},
	{
		id: "responses.parallel-tools.two-calls",
		feature: "responses.parallel-tools",
		needs: ["tools", "parallel_tool_calls"],
		run: async (target) => {
			const value = await completed(target, {
				input: askTwoCities,
				tools: tools(weather),
				parallel_tool_calls: true,
			});
			const calls = functionCalls(value);
			check(calls.length >= 2, `${calls.length} function calls, not 2`);
			check(
				new Set(calls.map((call) => call.call_id)).size === calls.length,
				"call_ids repeat",
			);
			for (const call of calls) checkArgs(call.arguments, weatherArgs);
		},
	},
	{
		id: "responses.stream-tools.arguments",
		feature: "responses.stream-tools",
		needs: ["tools"],
		run: async (target) => {
			const { types, final } = await stream(target, {
				input: askWeather,
				tools: tools(weather),
			});
			check(
				types.includes("response.function_call_arguments.done"),
				"no function_call_arguments.done",
			);
			const call = functionCalls(final)[0];
			check(call, "no function_call item in the final response");
			checkArgs(call.arguments, weatherArgs);
		},
	},
	{
		id: "responses.builtin-tools.web-search",
		feature: "responses.builtin-tools",
		needs: ["builtin_tools"],
		run: async (target) => {
			const value = await completed(target, {
				input:
					"Search the web: what is the title of the page at https://www.iana.org/help/example-domains ?",
				tools: [{ type: "web_search" }],
			});
			const searched = value.output.some(
				(item) => item.type === "web_search_call",
			);
			const cited = value.output.some(
				(item) =>
					item.type === "message" &&
					JSON.stringify(item).includes('"url_citation"'),
			);
			check(searched || cited, "no web_search_call item and no URL citation");
		},
	},
	{
		id: "responses.text-format.json-schema",
		feature: "responses.text-format",
		needs: ["structured_outputs"],
		run: async (target) => {
			const value = await completed(target, {
				input: askCity,
				max_output_tokens: jsonFixtureTokens,
				...(target.jsonFixtureEffort
					? { reasoning: { effort: target.jsonFixtureEffort } }
					: {}),
				text: { format: { type: "json_schema", ...cityFormat } },
			});
			shape(json(outputTextOf(value), "output_text"), city, "output_text");
		},
	},
	{
		id: "responses.text-format.json-schema-stream",
		feature: "responses.text-format",
		needs: ["structured_outputs"],
		run: async (target) => {
			const { final } = await stream(target, {
				input: askCity,
				max_output_tokens: jsonFixtureTokens,
				...(target.jsonFixtureEffort
					? { reasoning: { effort: target.jsonFixtureEffort } }
					: {}),
				text: { format: { type: "json_schema", ...cityFormat } },
			});
			shape(
				json(outputTextOf(final), "streamed output_text"),
				city,
				"streamed output_text",
			);
		},
	},
	{
		id: "responses.text-format.json-object",
		feature: "responses.text-format",
		needs: ["response_format"],
		run: async (target) => {
			const value = await completed(target, {
				input: `${askCity} Answer with a JSON object only.`,
				max_output_tokens: jsonFixtureTokens,
				...(target.jsonFixtureEffort
					? { reasoning: { effort: target.jsonFixtureEffort } }
					: {}),
				text: { format: { type: "json_object" } },
			});
			const parsed = json(outputTextOf(value), "output_text");
			check(
				parsed && typeof parsed === "object" && !Array.isArray(parsed),
				"output_text is not a JSON object",
			);
		},
	},
	{
		id: "responses.text-format.non-strict",
		feature: "responses.text-format",
		needs: ["structured_outputs", "json_schema_optional"],
		run: async (target) => {
			const value = await completed(target, {
				input: askCityNickname,
				max_output_tokens: jsonFixtureTokens,
				...(target.jsonFixtureEffort
					? { reasoning: { effort: target.jsonFixtureEffort } }
					: {}),
				text: { format: { type: "json_schema", ...nicknameFormat(false) } },
			});
			shape(
				json(outputTextOf(value), "output_text"),
				cityNickname,
				"output_text",
			);
		},
	},
	formatServedOrRefused(
		"responses.text-format.strict-optional",
		askCityNickname,
		nicknameFormat(true),
		(value, what) => shape(value, cityNickname, what),
	),
	formatServedOrRefused(
		"responses.text-format.keyword-not",
		askSky,
		skyFormat,
		checkSky,
	),
	formatServedOrRefused(
		"responses.text-format.empty-schema",
		askNotes,
		notesFormat,
		checkNotes,
	),
	{
		id: "responses.reasoning.tokens",
		feature: "responses.reasoning",
		needs: ["reasoning_tokens"],
		run: async (target) => {
			const value = await completed(target, {
				input: askJourney,
				reasoning: { effort: target.reasoningEffort ?? "medium" },
			});
			const reasoning = value.usage?.output_tokens_details?.reasoning_tokens;
			check(
				typeof reasoning === "number" && reasoning > 0,
				"no reasoning_tokens in usage",
			);
			mentions(outputTextOf(value), journeyMinutes, "answer");
		},
	},
	{
		id: "responses.reasoning.item",
		feature: "responses.reasoning",
		needs: ["reasoning"],
		run: async (target) => {
			const value = await completed(target, {
				input: askJourney,
				reasoning: {
					effort: target.reasoningEffort ?? "medium",
					summary: "auto",
				},
			});
			const kinds = value.output.map((item) => item.type);
			const at = kinds.indexOf("reasoning");
			check(at !== -1, "no reasoning item");
			check(
				at < kinds.indexOf("message"),
				"reasoning item does not precede the message",
			);
		},
	},
	{
		id: "responses.reasoning.stream",
		feature: "responses.reasoning",
		needs: ["reasoning"],
		run: async (target) => {
			const { final } = await stream(target, {
				input: askJourney,
				reasoning: {
					effort: target.reasoningEffort ?? "medium",
					summary: "auto",
				},
			});
			check(
				final.output.some((item) => item.type === "reasoning"),
				"no reasoning item in the stream",
			);
		},
	},
	{
		id: "responses.reasoning.stream-tokens",
		feature: "responses.reasoning",
		needs: ["reasoning_tokens"],
		run: async (target) => {
			const { final } = await stream(target, {
				input: askJourney,
				reasoning: { effort: target.reasoningEffort ?? "medium" },
			});
			const reasoning = final.usage?.output_tokens_details?.reasoning_tokens;
			check(
				typeof reasoning === "number" && reasoning > 0,
				"no reasoning_tokens in the stream's usage",
			);
		},
	},
	{
		id: "responses.reasoning.encrypted-replay",
		feature: "responses.reasoning",
		needs: ["encrypted_reasoning", "tools"],
		run: async (target) => {
			// A stateless client (E11): no stored response, the encrypted reasoning comes back with
			// the call and is sent again with the call's output, as the next turn's history.
			const input = [userText(askJourneyThenWeather)];
			const stateless = {
				tools: tools(weather),
				reasoning: { effort: target.reasoningEffort ?? "medium" },
				store: false,
				include: ["reasoning.encrypted_content"],
			};
			const first = await completed(target, { input, ...stateless });
			const call = functionCalls(first)[0];
			check(call, "no function_call item");
			const reasoning = first.output.filter(
				(item) => item.type === "reasoning",
			);
			check(reasoning.length > 0, "no reasoning item to replay");
			// Opaque reasoning comes back as `encrypted_content`; open-weight models' plain text in
			// `content` is replayable as it stands. An item with neither carries nothing to replay.
			check(
				reasoning.every(
					(item) =>
						(typeof item.encrypted_content === "string" &&
							item.encrypted_content.length > 0) ||
						(Array.isArray(item.content) && item.content.length > 0),
				),
				"a reasoning item has neither encrypted_content nor content",
			);
			const second = await completed(target, {
				input: [
					...input,
					...first.output,
					{
						type: "function_call_output",
						call_id: call.call_id,
						output: weatherResult,
					},
				],
				...stateless,
			});
			mentions(outputTextOf(second), "17", "answer after the replay");
		},
	},
	{
		id: "responses.images.remote-unavailable",
		feature: "responses.images",
		needs: ["image"],
		lacks: ["image_url"],
		run: async (target) =>
			checkRefused(
				await post(target, path, {
					input: withPart(askColour, image(redSquareUrl)),
				}),
			),
	},
	reads(
		"responses.images.url",
		"image_url",
		askColour,
		image(redSquareUrl),
		"red",
	),
	reads(
		"responses.images.base64",
		"image",
		askColour,
		image(fixtures.redSquare),
		"red",
	),
	reads(
		"responses.images.url-query",
		"image_url",
		askColour,
		image(redSquareSignedUrl),
		"red",
	),
	reads(
		"responses.images.url-redirect",
		"image_url",
		askColour,
		image(redSquareRedirectUrl),
		"red",
	),
	{
		id: "responses.images.mime-mismatch",
		feature: "responses.images",
		needs: ["image"],
		run: async (target) => {
			const answer = await post(target, path, {
				input: withPart(askColour, image(fixtures.jpegAsPng)),
			});
			await servedOrRefused(answer, response, "response", (value) =>
				mentions(outputTextOf(value), "red", "answer"),
			);
		},
	},
	{
		id: "responses.images.unsupported",
		feature: "responses.images",
		lacks: ["image"],
		run: async (target) => {
			const answer = await post(target, path, {
				input: withPart(askColour, image(fixtures.redSquare)),
			});
			if (answer.status !== 200) return checkRefused(answer);
			const value = shape(answer.body, response, "response");
			mentions(
				outputTextOf(value),
				"red",
				"an answer to an image the model cannot see",
			);
		},
	},
	reads(
		"responses.pdf.base64",
		"file",
		askCodeWord,
		{ type: "input_file", filename: "fixture.pdf", file_data: fixtures.pdf },
		codeWord,
	),
	reads(
		"responses.pdf.url",
		"file",
		askPdfLine,
		{ type: "input_file", file_url: helloPdfUrl },
		helloPdfWord,
	),
	{
		id: "responses.pdf.corrupt",
		feature: "responses.pdf",
		needs: ["file"],
		run: async (target) => {
			const answer = await post(target, path, {
				input: withPart(askCodeWord, {
					type: "input_file",
					filename: "fixture.pdf",
					file_data: fixtures.corruptPdf,
				}),
			});
			await servedOrRefused(answer, response, "response", checkResponse);
		},
	},
	{
		id: "responses.stateless.store",
		feature: "responses.stateless",
		run: async (target) => {
			await honouredOrRefused(
				target,
				{ input: askOk, store: true },
				async (value) => {
					checkResponse(value);
					const stored = await request(target, `${path}/${value.id}`);
					check(stored.status !== 404, "a stored response cannot be read back");
				},
			);
		},
	},
	{
		id: "responses.stateless.previous-response-id",
		feature: "responses.stateless",
		run: async (target) => {
			await honouredOrRefused(
				target,
				{ input: askOk, previous_response_id: "resp_conformance_unknown" },
				async () => {
					throw new Failure("an unknown previous_response_id was accepted");
				},
			);
		},
	},
	{
		id: "responses.max-output-tokens.incomplete",
		feature: "responses.max-output-tokens",
		needs: ["max_tokens"],
		run: async (target) => {
			const value = await respond(target, {
				input: "Write a 500-word essay about rivers.",
				max_output_tokens: 16,
			});
			check(
				value.status === "incomplete",
				`status is ${value.status}, not incomplete`,
			);
			check(
				value.incomplete_details?.reason === "max_output_tokens",
				"incomplete_details.reason is not max_output_tokens",
			);
		},
	},
	{
		id: "responses.sampling.temperature",
		feature: "responses.sampling",
		needs: ["temperature"],
		run: async (target) => {
			const value = await completed(target, { input: askOk, temperature: 0.2 });
			check(value.temperature === 0.2, "temperature is not echoed");
		},
	},
	{
		id: "responses.sampling.top-p",
		feature: "responses.sampling",
		needs: ["top_p"],
		run: async (target) => {
			const value = await completed(target, { input: askOk, top_p: 0.9 });
			check(value.top_p === 0.9, "top_p is not echoed");
		},
	},
	...samplingParams.slice(0, 2).map(
		([name, params]): Case => ({
			id: `responses.sampling.${name}-unlisted`,
			feature: "responses.sampling",
			lacks: [name],
			run: async (target) => {
				const answer = await post(target, path, { input: askOk, ...params });
				await servedOrRefused(answer, response, "response", checkResponse);
			},
		}),
	),
	{
		id: "responses.metadata.user",
		feature: "responses.metadata",
		run: async (target) => {
			await completed(target, { input: askOk, user: "conformance-suite" });
		},
	},
	{
		id: "responses.metadata.metadata",
		feature: "responses.metadata",
		run: async (target) => {
			const metadata = { suite: "conformance", run: "check" };
			const value = await completed(target, { input: askOk, metadata });
			check(
				JSON.stringify(value.metadata) === JSON.stringify(metadata),
				"metadata is not echoed",
			);
		},
	},
];
