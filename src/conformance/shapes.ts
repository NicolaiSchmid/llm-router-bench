import { z } from "zod";
import type { Event } from "./http.ts";
import { check, Failure, shape } from "./suite.ts";

/**
 * The wire shapes the suite asserts, written from the OpenAI API and
 * OpenRouter's OpenAPI file (sources in the plan's feature matrix). Only the
 * fields the APIs promise are required; everything else may be present.
 */

const count = z.number().int().nonnegative();

// --- Chat Completions -------------------------------------------------------

const finishReasons = [
	"stop",
	"length",
	"tool_calls",
	"content_filter",
	"error",
] as const;

const chatUsage = z.looseObject({
	prompt_tokens: count,
	completion_tokens: count,
	total_tokens: count,
	prompt_tokens_details: z
		.looseObject({ cached_tokens: count.optional() })
		.nullish(),
	completion_tokens_details: z
		.looseObject({ reasoning_tokens: count.optional() })
		.nullish(),
});

export type ChatUsage = z.infer<typeof chatUsage>;

const toolCall = z.looseObject({
	id: z.string().min(1),
	type: z.literal("function"),
	function: z.looseObject({ name: z.string().min(1), arguments: z.string() }),
});

const tokenLogprob = z.looseObject({
	token: z.string(),
	logprob: z.number().max(0),
	top_logprobs: z
		.array(z.looseObject({ token: z.string(), logprob: z.number().max(0) }))
		.nullish(),
});

export const completion = z.looseObject({
	id: z.string().min(1),
	object: z.literal("chat.completion"),
	created: z.number(),
	model: z.string().min(1),
	choices: z
		.array(
			z.looseObject({
				index: z.number(),
				message: z.looseObject({
					role: z.literal("assistant"),
					content: z.string().nullable(),
					tool_calls: z.array(toolCall).nullish(),
					reasoning: z.string().nullish(),
				}),
				// OpenRouter's schema allows null here; cases that care check the value.
				finish_reason: z.enum(finishReasons).nullable(),
				logprobs: z
					.looseObject({ content: z.array(tokenLogprob).nullable() })
					.nullish(),
			}),
		)
		.min(1),
	usage: chatUsage,
});

export type Completion = z.infer<typeof completion>;

/** A completion assembled from a stream: usage comes only when asked for (OpenAI) or always (OpenRouter). */
const assembledCompletion = completion.extend({ usage: chatUsage.optional() });

export const chunk = z.looseObject({
	id: z.string().min(1),
	object: z.literal("chat.completion.chunk"),
	created: z.number(),
	model: z.string().min(1),
	choices: z.array(
		z.looseObject({
			index: z.number(),
			delta: z.looseObject({
				role: z.string().nullish(),
				content: z.string().nullish(),
				reasoning: z.string().nullish(),
				tool_calls: z
					.array(
						z.looseObject({
							index: z.number(),
							id: z.string().nullish(),
							function: z
								.looseObject({
									name: z.string().nullish(),
									arguments: z.string().nullish(),
								})
								.nullish(),
						}),
					)
					.nullish(),
			}),
			finish_reason: z.enum(finishReasons).nullish(),
		}),
	),
	usage: chatUsage.nullish(),
});

export type Chunk = z.infer<typeof chunk>;

/** Usage numbers that add up: total = prompt + completion, reasoning within completion. */
export function checkChatUsage(usage: ChatUsage) {
	check(
		usage.total_tokens === usage.prompt_tokens + usage.completion_tokens,
		"usage.total_tokens is not prompt_tokens + completion_tokens",
	);
	check(usage.prompt_tokens > 0, "usage.prompt_tokens is 0");
	const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
	check(
		reasoning <= usage.completion_tokens,
		"reasoning_tokens exceed completion_tokens",
	);
}

export type ChatStream = {
	chunks: Chunk[];
	/** The chunks put back together as a whole completion, with usage when the stream carried it. */
	assembled: z.infer<typeof assembledCompletion>;
	/** The reasoning text the deltas carried. */
	reasoning: string;
	/** Index in `chunks` of the chunk carrying usage, or -1. */
	usageAt: number;
};

/**
 * Checks a chat completion stream (one id, chunks before `[DONE]`, nothing
 * after it) and assembles it: content and reasoning concatenated, tool call
 * deltas merged by index, the finish reason and usage taken from the chunks
 * that carry them.
 */
export function chatStream(events: Event[]): ChatStream {
	const doneAt = events.findIndex((event) => event.data === "[DONE]");
	check(doneAt !== -1, "stream does not end with [DONE]");
	check(doneAt === events.length - 1, "events follow [DONE]");
	const chunks = events.slice(0, doneAt).map((event, index) => {
		if (event.data && typeof event.data === "object" && "error" in event.data) {
			const message = (event.data as { error?: { message?: unknown } }).error
				?.message;
			throw new Failure(
				"error inside the stream",
				typeof message === "string" ? message : undefined,
			);
		}
		return shape(event.data, chunk, `chunk ${index}`);
	});
	check(chunks.length > 0, "stream has no chunks");
	const first = chunks[0] as Chunk;
	check(
		chunks.every((c) => c.id === first.id),
		"chunks of one stream carry different ids",
	);

	let content: string | null = null;
	let reasoning = "";
	let role: string | undefined;
	let finish: Chunk["choices"][number]["finish_reason"] = null;
	let usage: ChatUsage | undefined;
	let usageAt = -1;
	const calls = new Map<
		number,
		{
			id: string;
			type: "function";
			function: { name: string; arguments: string };
		}
	>();
	chunks.forEach((c, index) => {
		if (c.usage) {
			usage = c.usage;
			usageAt = index;
		}
		for (const choice of c.choices) {
			const delta = choice.delta;
			role ??= delta.role ?? undefined;
			if (delta.content) content = (content ?? "") + delta.content;
			if (delta.reasoning) reasoning += delta.reasoning;
			for (const call of delta.tool_calls ?? []) {
				const merged = calls.get(call.index) ?? {
					id: "",
					type: "function" as const,
					function: { name: "", arguments: "" },
				};
				if (call.id) merged.id = call.id;
				if (call.function?.name) merged.function.name += call.function.name;
				if (call.function?.arguments)
					merged.function.arguments += call.function.arguments;
				calls.set(call.index, merged);
			}
			if (choice.finish_reason) finish = choice.finish_reason;
		}
	});
	const assembled = shape(
		{
			id: first.id,
			object: "chat.completion",
			created: first.created,
			model: first.model,
			choices: [
				{
					index: 0,
					message: {
						role,
						content,
						...(calls.size > 0 ? { tool_calls: [...calls.values()] } : {}),
					},
					finish_reason: finish,
				},
			],
			usage,
		},
		assembledCompletion,
		"assembled stream",
	);
	return { chunks, assembled, reasoning, usageAt };
}

// --- Responses --------------------------------------------------------------

const responsesUsage = z.looseObject({
	input_tokens: count,
	output_tokens: count,
	total_tokens: count,
	input_tokens_details: z
		.looseObject({ cached_tokens: count.optional() })
		.nullish(),
	output_tokens_details: z
		.looseObject({ reasoning_tokens: count.optional() })
		.nullish(),
});

const outputText = z.looseObject({
	type: z.literal("output_text"),
	text: z.string(),
	annotations: z.array(z.looseObject({ type: z.string() })).optional(),
});

const messageItem = z.looseObject({
	type: z.literal("message"),
	id: z.string().min(1),
	role: z.literal("assistant"),
	status: z.string().optional(),
	content: z.array(
		z.union([
			outputText,
			z.looseObject({ type: z.literal("refusal"), refusal: z.string() }),
		]),
	),
});

const functionCallItem = z.looseObject({
	type: z.literal("function_call"),
	call_id: z.string().min(1),
	name: z.string().min(1),
	arguments: z.string(),
});

const reasoningItem = z.looseObject({
	type: z.literal("reasoning"),
	id: z.string().min(1),
	summary: z.array(z.looseObject({ type: z.string(), text: z.string() })),
});

const knownItems: Record<string, z.ZodType> = {
	message: messageItem,
	function_call: functionCallItem,
	reasoning: reasoningItem,
};

/** An output item: known types parsed strictly, others (built-in tool calls) only typed. */
const outputItem = z
	.looseObject({ type: z.string() })
	.superRefine((item, context) => {
		const schema = knownItems[item.type];
		const parsed = schema?.safeParse(item);
		if (parsed && !parsed.success) {
			for (const issue of parsed.error.issues)
				context.addIssue({ ...issue, path: issue.path });
		}
	});

export const response = z.looseObject({
	id: z.string().min(1),
	object: z.literal("response"),
	created_at: z.number(),
	status: z.enum([
		"completed",
		"incomplete",
		"failed",
		"in_progress",
		"queued",
		"cancelled",
	]),
	model: z.string().min(1),
	output: z.array(outputItem),
	usage: responsesUsage.nullish(),
	error: z.unknown().nullish(),
	incomplete_details: z.looseObject({ reason: z.string() }).nullish(),
});

export type Response = z.infer<typeof response>;
export type MessageItem = z.infer<typeof messageItem>;
export type FunctionCallItem = z.infer<typeof functionCallItem>;

/** The concatenated `output_text` of a response's message items. */
export const outputTextOf = (value: Response) =>
	value.output
		.filter((item) => item.type === "message")
		.flatMap((item) => (item as MessageItem).content)
		.map((part) => ("text" in part ? part.text : ""))
		.join("");

export const functionCalls = (value: Response) =>
	value.output.filter(
		(item) => item.type === "function_call",
	) as FunctionCallItem[];

/** A completed response with usage that adds up. */
export function checkResponse(value: Response) {
	check(
		value.status === "completed",
		`status is ${value.status}, not completed`,
	);
	check(value.output.length > 0, "output is empty");
	check(value.usage, "usage is missing");
	check(
		value.usage.total_tokens ===
			value.usage.input_tokens + value.usage.output_tokens,
		"usage.total_tokens is not input_tokens + output_tokens",
	);
	check(value.usage.input_tokens > 0, "usage.input_tokens is 0");
	const reasoning = value.usage.output_tokens_details?.reasoning_tokens ?? 0;
	check(
		reasoning <= value.usage.output_tokens,
		"reasoning_tokens exceed output_tokens",
	);
}

const streamEvent = z.looseObject({
	type: z.string(),
	sequence_number: z.number().int(),
});
type StreamEvent = z.infer<typeof streamEvent> & {
	output_index?: number;
	item_id?: string;
	content_index?: number;
	delta?: string;
	text?: string;
	arguments?: string;
	item?: { type?: string; id?: string };
	response?: unknown;
};

const terminal = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
]);

export type ResponsesStream = {
	events: StreamEvent[];
	/** The response the terminal event carries, parsed with `response`. */
	final: Response;
	types: string[];
};

/**
 * Checks the order of a Responses stream and that its pieces add up
 * (.plans/2026-10-30-gateway-conformance.md, `responses.stream`):
 * `response.created` first and one terminal event last, rising sequence
 * numbers, every item added before its parts and deltas and done after
 * them, text and argument deltas that equal their `.done` events and the
 * final response, and items opened and closed in the shape of final ones.
 */
export function responsesStream(events: Event[]): ResponsesStream {
	const parsed = events
		.filter((event) => event.data !== "[DONE]")
		.map(
			(event, index) =>
				shape(event.data, streamEvent, `event ${index}`) as StreamEvent,
		);
	check(parsed.length > 0, "stream has no events");
	const types = parsed.map((event) => event.type);
	if (types.includes("error")) throw new Failure("stream has an error event");
	check(
		types[0] === "response.created",
		`first event is ${types[0]}, not response.created`,
	);
	const terminals = types.filter((type) => terminal.has(type));
	check(
		terminals.length === 1,
		`stream has ${terminals.length} terminal events`,
	);
	check(
		terminal.has(types.at(-1) as string),
		"events follow the terminal event",
	);
	parsed.forEach((event, index) => {
		const previous = parsed[index - 1];
		check(
			!previous || event.sequence_number > previous.sequence_number,
			"sequence_number does not rise",
		);
		if (
			event.type !== "response.output_item.added" &&
			typeof event.output_index === "number"
		) {
			const added = parsed
				.slice(0, index)
				.some(
					(e) =>
						e.type === "response.output_item.added" &&
						e.output_index === event.output_index,
				);
			check(added, `${event.type} before its output item was added`);
		}
		if (
			event.type !== "response.output_item.done" &&
			typeof event.output_index === "number"
		) {
			const closed = parsed
				.slice(0, index)
				.some(
					(e) =>
						e.type === "response.output_item.done" &&
						e.output_index === event.output_index,
				);
			check(!closed, `${event.type} after its output item was done`);
		}
		if (event.type === "response.output_text.delta") {
			const opened = parsed
				.slice(0, index)
				.some(
					(e) =>
						e.type === "response.content_part.added" &&
						e.item_id === event.item_id &&
						e.content_index === event.content_index,
				);
			check(opened, "output_text.delta before its content part was added");
		}
	});

	const final = shape(
		(parsed.at(-1) as StreamEvent).response,
		response,
		"response in the terminal event",
	);
	const deltas = (type: string, key: (e: StreamEvent) => string) => {
		const joined = new Map<string, string>();
		for (const event of parsed.filter((e) => e.type === type)) {
			joined.set(
				key(event),
				(joined.get(key(event)) ?? "") + (event.delta ?? ""),
			);
		}
		return joined;
	};
	const textKey = (e: StreamEvent) => `${e.item_id}:${e.content_index}`;
	const texts = deltas("response.output_text.delta", textKey);
	for (const done of parsed.filter(
		(e) => e.type === "response.output_text.done",
	)) {
		check(
			(texts.get(textKey(done)) ?? "") === done.text,
			"output_text deltas do not add up to .done",
		);
	}
	const finalTexts = [...texts.values()].join("");
	check(
		finalTexts === outputTextOf(final),
		"streamed text differs from the final response",
	);
	const args = deltas("response.function_call_arguments.delta", (e) =>
		String(e.item_id),
	);
	for (const done of parsed.filter(
		(e) => e.type === "response.function_call_arguments.done",
	)) {
		check(
			(args.get(String(done.item_id)) ?? "") === done.arguments,
			"function_call_arguments deltas do not add up to .done",
		);
	}
	const added = parsed.filter(
		(e) => e.type === "response.output_item.added",
	).length;
	check(
		added === final.output.length,
		"final output and added items differ in number",
	);
	// The items the stream opens and closes have the shape of final ones: a client that reads
	// them as they come (the OpenAI Agents SDK) fails on a reasoning `summary: null`.
	for (const event of parsed) {
		if (
			event.type !== "response.output_item.added" &&
			event.type !== "response.output_item.done"
		)
			continue;
		const item = shape(event.item, outputItem, `${event.type} item`);
		if (event.type === "response.output_item.done") {
			check(
				item.type === final.output[event.output_index ?? -1]?.type,
				"output_item.done differs in type from the final output item",
			);
		}
	}
	return { events: parsed, final, types };
}
