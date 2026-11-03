import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clientFailure } from "./cases/client.ts";
import { checkModel, checkNotes, checkSky } from "./cases/common.ts";
import { answersText, padded } from "./cases/errors.ts";
import { fixtures } from "./fixtures.ts";
import type { Event, Target } from "./http.ts";
import { compare, resultFile } from "./report.ts";
import { chatStream, responsesStream } from "./shapes.ts";
import {
	type Case,
	check,
	checkErrorBody,
	Failure,
	isIdentifier,
	refusal,
	runCases,
	servedOrRefused,
} from "./suite.ts";

/**
 * The suite's own judges, offline: a wrong checker would misreport every
 * target, so the stream checks, the runner and the fixtures are pinned here.
 * The cases themselves are proven by the reference run against OpenRouter
 * (.plans/2026-10-30-gateway-conformance.md, decision 3).
 */

const chunk = (
	delta: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) => ({
	data: {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "m",
		choices: [{ index: 0, delta, finish_reason: null }],
		...extra,
	},
	event: undefined,
});
const done: Event = { data: "[DONE]", event: undefined };
const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };

const reasonOf = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		return error instanceof Failure ? error.reason : String(error);
	}
	return null;
};

describe("chatStream", () => {
	it("assembles content, tool call deltas by index, the finish reason and usage", () => {
		const { assembled, usageAt } = chatStream([
			chunk({ role: "assistant", content: "" }),
			chunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						function: { name: "get_weather", arguments: '{"ci' },
					},
				],
			}),
			chunk({
				tool_calls: [{ index: 0, function: { arguments: 'ty":"Berlin"}' } }],
			}),
			chunk(
				{},
				{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			),
			chunk({}, { choices: [], usage }),
			done,
		]);
		const choice = assembled.choices[0];
		expect(choice?.message.tool_calls?.[0]?.function).toEqual({
			name: "get_weather",
			arguments: '{"city":"Berlin"}',
		});
		expect(choice?.finish_reason).toBe("tool_calls");
		expect(assembled.usage).toEqual(usage);
		expect(usageAt).toBe(4);
	});

	it("accepts OpenRouter's usage chunk, which repeats the finish reason in one empty choice", () => {
		const { assembled } = chatStream([
			chunk(
				{ role: "assistant", content: "OK" },
				{
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: "OK" },
							finish_reason: "stop",
						},
					],
				},
			),
			chunk(
				{},
				{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
			),
			done,
		]);
		expect(assembled.choices[0]?.message.content).toBe("OK");
	});

	it("fails a stream without [DONE], with events after it, or with two ids", () => {
		expect(reasonOf(() => chatStream([chunk({ content: "a" })]))).toMatch(
			/\[DONE\]/,
		);
		expect(
			reasonOf(() => chatStream([chunk({ content: "a" }), done, chunk({})])),
		).toMatch(/follow/);
		const other = chunk({ content: "b" });
		(other.data as { id: string }).id = "chatcmpl-2";
		expect(
			reasonOf(() => chatStream([chunk({ role: "assistant" }), other, done])),
		).toMatch(/ids/);
	});
});

const message = (text: string, status = "completed") => ({
	type: "message",
	id: "msg_1",
	role: "assistant",
	status,
	content: [{ type: "output_text", text, annotations: [] }],
});
const resp = (status: string, output: unknown[]) => ({
	id: "resp_1",
	object: "response",
	created_at: 1,
	status,
	model: "m",
	output,
	usage:
		status === "completed"
			? { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
			: null,
});
const part = { item_id: "msg_1", output_index: 0, content_index: 0 };

/** A valid Responses stream for one message "Hello", as OpenAI sends it. */
function stream(): Event[] {
	const events = [
		{ type: "response.created", response: resp("in_progress", []) },
		{ type: "response.in_progress", response: resp("in_progress", []) },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message("", "in_progress"), content: [] },
		},
		{
			type: "response.content_part.added",
			...part,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", ...part, delta: "Hel" },
		{ type: "response.output_text.delta", ...part, delta: "lo" },
		{ type: "response.output_text.done", ...part, text: "Hello" },
		{ type: "response.content_part.done", ...part },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: message("Hello"),
		},
		{
			type: "response.completed",
			response: resp("completed", [message("Hello")]),
		},
	];
	return events.map((data, sequence_number) => ({
		data: { ...data, sequence_number },
		event: data.type,
	}));
}

describe("responsesStream", () => {
	it("accepts a well-ordered stream whose deltas add up", () => {
		const { final, types } = responsesStream(stream());
		expect(final.status).toBe("completed");
		expect(types.at(-1)).toBe("response.completed");
	});

	it("fails a delta before its content part, falling sequence numbers and deltas that do not add up", () => {
		const early = stream();
		[early[3], early[4]] = [early[4] as Event, early[3] as Event];
		for (const [index, event] of early.entries())
			(event.data as { sequence_number: number }).sequence_number = index;
		expect(reasonOf(() => responsesStream(early))).toMatch(
			/before its content part/,
		);

		const falling = stream();
		(falling[5]?.data as { sequence_number: number }).sequence_number = 1;
		expect(reasonOf(() => responsesStream(falling))).toMatch(/sequence_number/);

		const short = stream();
		(short[5]?.data as { delta: string }).delta = "p";
		expect(reasonOf(() => responsesStream(short))).toMatch(/add up/);
	});

	it("fails an item the stream closes in another shape than a final one (a reasoning summary of null)", () => {
		const events = stream();
		const reasoning = { type: "reasoning", id: "rs_1", summary: [] };
		const done = {
			type: "response.output_item.done",
			output_index: 0,
			item: { ...reasoning, summary: null },
		};
		const shifted = [
			{ type: "response.created", response: resp("in_progress", []) },
			{ type: "response.output_item.added", output_index: 0, item: reasoning },
			done,
			...events.slice(2).map(({ data }) => {
				const event = data as {
					output_index?: number;
					item?: unknown;
					response?: { output: unknown[] };
				};
				if (typeof event.output_index === "number") event.output_index = 1;
				if (event.response?.output.length)
					event.response.output = [reasoning, ...event.response.output];
				return event;
			}),
		].map((data, sequence_number) => ({
			data: { ...data, sequence_number },
			event: undefined,
		}));
		expect(reasonOf(() => responsesStream(shifted))).toMatch(
			/output_item.done item has the wrong shape/,
		);
		done.item.summary = [] as never;
		expect(reasonOf(() => responsesStream(shifted))).toBeNull();
	});

	it("fails an item closed with another type than the final response gives it", () => {
		const events = stream();
		(events[8]?.data as { item: unknown }).item = {
			type: "reasoning",
			id: "rs_1",
			summary: [],
		};
		expect(reasonOf(() => responsesStream(events))).toMatch(/differs in type/);
	});

	it("fails a stream without exactly one terminal event at the end", () => {
		expect(reasonOf(() => responsesStream(stream().slice(0, -1)))).toMatch(
			/0 terminal/,
		);
	});
});

const target: Target = {
	baseUrl: "http://localhost",
	apiKey: "k",
	model: "m",
	timeoutMs: 1000,
};
const testCase = (id: string, run: Case["run"], needs?: string[]): Case => ({
	id,
	feature: id.split(".").slice(0, 2).join("."),
	needs,
	run,
});

describe("refusal", () => {
	it("keeps an error code that is an identifier and drops one that is text", () => {
		expect(
			refusal({ status: 400, body: { error: { code: "invalid_prompt" } } })
				.reason,
		).toBe("HTTP 400 (invalid_prompt)");
		expect(
			refusal({
				status: 400,
				body: { error: { code: "the prompt said: hello" } },
			}).reason,
		).toBe("HTTP 400");
	});
});

describe("runCases", () => {
	it("reports pass, fail with the suite's reason, unsupported by capability, and expected failures", async () => {
		const results = await runCases(
			[
				testCase("chat.a.pass", async () => {}),
				testCase("chat.a.fail", async () => check(false, "no tool call")),
				testCase("chat.b.vision", async () => {}, ["image"]),
				testCase("chat.b.known", async () => {
					throw new Failure("HTTP 400", "a server message, never saved");
				}),
			],
			target,
			{
				capabilities: new Set(["tools"]),
				expected: { "chat.b.known": "documented gap" },
				concurrency: 2,
				onResult: () => {},
			},
		);
		expect(
			results.map(({ id, status, reason }) => [id, status, reason]),
		).toEqual([
			["chat.a.pass", "pass", undefined],
			["chat.a.fail", "fail", "no tool call"],
			["chat.b.vision", "unsupported", "needs image"],
			["chat.b.known", "fail", "HTTP 400"],
		]);
		const file = resultFile(results, {
			date: "2026-10-30",
			target: { mock: true, model: "m" },
			capabilities: { source: "flag", list: ["tools"] },
			expect: null,
		});
		expect(JSON.stringify(file)).not.toContain("server message");
		expect(JSON.stringify(file)).not.toContain("documented gap");
		expect(file.summary).toMatchObject({
			pass: 1,
			fail: 2,
			unsupported: 1,
			expectedFailures: 1,
		});
	});

	it("runs every case when no capabilities are known", async () => {
		const [result] = await runCases(
			[testCase("chat.b.vision", async () => {}, ["image"])],
			target,
			{
				capabilities: null,
				expected: {},
				concurrency: 1,
				onResult: () => {},
			},
		);
		expect(result?.status).toBe("pass");
	});

	it("runs a case for a missing capability only when the model is known to lack it", async () => {
		const textOnly = testCase("chat.images.unsupported", async () => {});
		textOnly.lacks = ["image"];
		const statuses = async (capabilities: Set<string> | null) =>
			(
				await runCases([textOnly], target, {
					capabilities,
					expected: {},
					concurrency: 1,
					onResult: () => {},
				})
			).map(({ status, reason }) => [status, reason]);
		expect(await statuses(new Set(["tools"]))).toEqual([["pass", undefined]]);
		expect(await statuses(new Set(["image"]))).toEqual([
			["unsupported", "needs a model without image"],
		]);
		expect(await statuses(null)).toEqual([
			["unsupported", "needs known capabilities"],
		]);
		textOnly.lacks = [];
		expect(await statuses(null)).toEqual([["pass", undefined]]);
		textOnly.lacks = ["image"];
		textOnly.needs = ["tools"];
		expect(await statuses(new Set())).toEqual([["unsupported", "needs tools"]]);
	});
});

const json = (body: unknown, type = "application/json") => ({
	status: 400,
	headers: new Headers({ "content-type": type }),
	body,
});

describe("checkErrorBody", () => {
	it("accepts OpenAI's string code and OpenRouter's numeric one", () => {
		expect(
			reasonOf(() =>
				checkErrorBody(
					json({
						error: { message: "Invalid model", type: "invalid_request_error" },
					}),
				),
			),
		).toBeNull();
		expect(
			reasonOf(() =>
				checkErrorBody(json({ error: { message: "No auth", code: 401 } })),
			),
		).toBeNull();
	});

	it("fails what a client cannot read: HTML, no type or code, a bare reason phrase, serialised JSON", () => {
		expect(reasonOf(() => checkErrorBody(json(null, "text/html")))).toMatch(
			/application\/json/,
		);
		expect(
			reasonOf(() => checkErrorBody(json({ error: { message: "Oops" } }))),
		).toMatch(/neither type nor code/);
		expect(
			reasonOf(() =>
				checkErrorBody(json({ error: { message: "Bad Request", code: 400 } })),
			),
		).toMatch(/reason phrase/);
		const upstream = JSON.stringify({ error: { message: "too long" } });
		expect(
			reasonOf(() =>
				checkErrorBody(json({ error: { message: upstream, code: 400 } })),
			),
		).toMatch(/serialised JSON/);
		expect(reasonOf(() => checkErrorBody(json({ message: "flat" })))).toMatch(
			/wrong shape/,
		);
	});

	it("reads the media type with parameters, trims the phrase, and tells JSON from text that only starts like it", () => {
		const body = (
			message: string,
			extra: Record<string, unknown> = { code: 400 },
		) =>
			json({ error: { message, ...extra } }, "application/json; charset=utf-8");
		expect(reasonOf(() => checkErrorBody(body("Model not found")))).toBeNull();
		expect(reasonOf(() => checkErrorBody(body("  bad request ")))).toMatch(
			/reason phrase/,
		);
		expect(reasonOf(() => checkErrorBody(body("[1]")))).toMatch(
			/serialised JSON/,
		);
		expect(reasonOf(() => checkErrorBody(body("{oops")))).toBeNull();
		expect(reasonOf(() => checkErrorBody(body("Oops", { type: "" })))).toMatch(
			/neither type nor code/,
		);
		expect(
			reasonOf(() =>
				checkErrorBody({
					headers: new Headers(),
					body: { error: { message: "x", code: 1 } },
				}),
			),
		).toMatch(/application\/json/);
	});
});

describe("servedOrRefused", () => {
	const ok = {
		error: {
			message: "strict mode needs every property",
			type: "invalid_request_error",
		},
	};
	const run = async (status: number, body: unknown) => {
		let served = false;
		try {
			await servedOrRefused(
				{ ...json(body), status },
				z.looseObject({ ok: z.literal(true) }),
				"answer",
				() => {
					served = true;
				},
			);
			return served ? "served" : "refused";
		} catch (error) {
			return (error as Failure).reason;
		}
	};

	it("hands a 200 to the check, accepts a readable 4xx and fails a 5xx", async () => {
		expect(await run(200, { ok: true })).toBe("served");
		expect(await run(400, ok)).toBe("refused");
		expect(await run(502, ok)).toBe("HTTP 502 (invalid_request_error)");
		expect(
			await run(400, { error: { message: "Bad Request", code: 400 } }),
		).toMatch(/reason phrase/);
		expect(await run(201, { ok: true })).toBe("HTTP 201");
	});

	it("does not count a refusal of the caller (rate limit, credits, key) as a refusal of the request", async () => {
		expect(await run(404, ok)).toBe("refused");
		expect(await run(429, ok)).toBe("HTTP 429 (invalid_request_error)");
		expect(await run(402, ok)).toBe("HTTP 402 (invalid_request_error)");
	});
});

describe("checkModel", () => {
	it("accepts the id with or without vendor and a dated form, and fails another model", () => {
		expect(
			reasonOf(() => checkModel("openai/gpt-5-nano", "openai/gpt-5-nano")),
		).toBeNull();
		expect(
			reasonOf(() => checkModel("gpt-5-nano-2025-08-07", "openai/gpt-5-nano")),
		).toBeNull();
		expect(
			reasonOf(() =>
				checkModel("claude-haiku-5-5", "anthropic/claude-haiku-5.5"),
			),
		).toBeNull();
		expect(reasonOf(() => checkModel("gpt-5", "openai/gpt-5-nano"))).toMatch(
			/another model/,
		);
		expect(
			reasonOf(() => checkModel("openai/gpt-5-nano", "openai/gpt-5")),
		).toMatch(/another model/);
		expect(reasonOf(() => checkModel("gpt-4o-mini", "openai/gpt-4o"))).toMatch(
			/another model/,
		);
		expect(
			reasonOf(() =>
				checkModel("claude-haiku-5-5-20261001", "anthropic/claude-haiku-5.5"),
			),
		).toBeNull();
		expect(
			reasonOf(() => checkModel("openai/gpt-4o:free", "openai/gpt-4o")),
		).toBeNull();
	});
});

describe("schema dialect checks", () => {
	it("fails an answer the not keyword forbids and a missing property typed {}", () => {
		expect(reasonOf(() => checkSky({ colour: "blue" }, "c"))).toMatch(
			/not keyword/,
		);
		expect(reasonOf(() => checkSky({ colour: "azure" }, "c"))).toBeNull();
		expect(reasonOf(() => checkSky({ colour: "red", extra: 1 }, "c"))).toMatch(
			/wrong shape/,
		);
		expect(reasonOf(() => checkNotes({ name: "M" }, "c"))).toMatch(
			/wrong shape/,
		);
		expect(
			reasonOf(() => checkNotes({ name: "M", details: null }, "c")),
		).toBeNull();
	});
});

describe("clientFailure", () => {
	it("saves a client error's name and status only, and drops a name that is not an identifier", () => {
		const apiError = Object.assign(new Error("server said: secret text"), {
			name: "AI_APICallError",
			statusCode: 429,
		});
		const failure = clientFailure(apiError);
		expect(failure.reason).toBe("AI_APICallError (HTTP 429)");
		expect(failure.detail).toContain("secret text");
		expect(
			clientFailure(
				Object.assign(new Error("x"), { name: "BadRequestError", status: 400 }),
			).reason,
		).toBe("BadRequestError (HTTP 400)");
		expect(
			clientFailure(Object.assign(new Error("x"), { name: "not an id" }))
				.reason,
		).toBe("client error");
		expect(clientFailure("thrown text").reason).toBe("client error");
		const own = new Failure("no text");
		expect(clientFailure(own)).toBe(own);
		expect([
			isIdentifier(""),
			isIdentifier("a".repeat(65)),
			isIdentifier("AI_APICallError"),
		]).toEqual([false, false, true]);
	});
});

describe("models and bodies", () => {
	it("pads a body to over 5 MiB that still parses as the request", () => {
		const body = padded(target, { input: "x" });
		expect(JSON.parse(body)).toEqual({ model: "m", input: "x" });
		expect(body.length).toBeGreaterThan(5 * 1024 * 1024);
	});

	it("takes a chat request only to models that answer text", () => {
		expect(
			answersText({ id: "a", architecture: { output_modalities: ["image"] } }),
		).toBe(false);
		expect(answersText({ id: "openai/text-embedding-3-small" })).toBe(false);
		expect(answersText({ id: "openai/gpt-5" })).toBe(true);
		expect(
			answersText({
				id: "x-embed",
				architecture: { output_modalities: ["text"] },
			}),
		).toBe(true);
	});
});

describe("compare", () => {
	it("lists the cases whose status changed", async () => {
		const meta = {
			date: "2026-10-30",
			target: { mock: true as const, model: "m" },
			capabilities: { source: "none" as const, list: [] },
			expect: null,
		};
		const before = resultFile(
			[{ id: "chat.a.x", feature: "chat.a", status: "fail", ms: 1 }],
			meta,
		);
		const after = resultFile(
			[{ id: "chat.a.x", feature: "chat.a", status: "pass", ms: 1 }],
			meta,
		);
		expect(compare(before, after)).toContain("chat.a.x: fail -> pass");
	});
});

describe("fixtures", () => {
	const bytes = (dataUrl: string) =>
		Buffer.from(dataUrl.split(",")[1] ?? "", "base64");

	it("draws a 64-pixel PNG", () => {
		const png = bytes(fixtures.redSquare);
		expect(png.subarray(1, 4).toString()).toBe("PNG");
		expect(png.readUInt32BE(16)).toBe(64);
	});

	it("writes a PDF whose startxref points at its cross-reference table", () => {
		const pdf = bytes(fixtures.pdf).toString("latin1");
		const offset = Number(pdf.match(/startxref\n(\d+)/)?.[1]);
		expect(pdf.slice(offset, offset + 4)).toBe("xref");
		expect(pdf).toContain("PELICAN");
	});

	it("draws a 64-pixel baseline JPEG and labels it PNG", () => {
		expect(fixtures.jpegAsPng.startsWith("data:image/png;base64,")).toBe(true);
		const jpeg = bytes(fixtures.jpegAsPng);
		expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
		expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
		const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
		expect([jpeg.readUInt16BE(sof + 5), jpeg.readUInt16BE(sof + 7)]).toEqual([
			64, 64,
		]);
	});

	it("writes a corrupt PDF: the header without a cross-reference table or an end", () => {
		const pdf = bytes(fixtures.corruptPdf).toString("latin1");
		expect(pdf.startsWith("%PDF-")).toBe(true);
		expect(pdf).not.toContain("xref");
		expect(pdf).not.toContain("%%EOF");
	});

	it("writes a WAV whose header counts its samples", () => {
		const wav = Buffer.from(fixtures.toneWav, "base64");
		expect(wav.subarray(0, 4).toString()).toBe("RIFF");
		expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
	});
});

it("does not impose a declared gateway limit on a target without capability metadata", async () => {
	let called = false;
	const results = await runCases(
		[
			{
				id: "errors.input-limit.synthetic",
				feature: "errors.input-limit",
				needs: ["gateway_input_limit"],
				requiresKnownCapabilities: true,
				run: async () => {
					called = true;
				},
			},
		],
		{
			baseUrl: "https://synthetic.invalid",
			model: "synthetic",
			apiKey: "synthetic",
			timeoutMs: 100,
		},
		{ capabilities: null, expected: {}, concurrency: 1, onResult: () => {} },
	);
	expect(called).toBe(false);
	expect(results[0]?.status).toBe("unsupported");
});

it("keeps OCR and Decisions out of generic text-chat sibling probes", () => {
	expect(
		answersText({
			id: "synthetic/ocr",
			architecture: {
				input_modalities: ["image"],
				output_modalities: ["text"],
			},
			supported_endpoints: ["/chat/completions"],
		}),
	).toBe(false);
	expect(
		answersText({
			id: "synthetic/decisions",
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
			supported_endpoints: ["/decisions"],
		}),
	).toBe(false);
	expect(
		answersText({
			id: "synthetic/chat",
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
			supported_endpoints: ["/chat/completions", "/responses"],
		}),
	).toBe(true);
});
