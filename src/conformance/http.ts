import { EventSourceParserStream } from "eventsource-parser/stream";

/**
 * Requests to the target. Every helper returns what came over the wire
 * (status, headers, parsed body or events) and leaves judging it to the
 * cases; nothing here retries or repairs an answer.
 */

export type Target = {
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	/** A documented native effort supported by this target. */
	reasoningEffort?: string;
	/** Disable optional reasoning for forced-tool parameter checks when native support exists. */
	toolChoiceEffort?: "none";
	/** Lowest documented effort for finite JSON format probes. */
	jsonFixtureEffort?: string;
	deterministicImages?: boolean;
};

export type Json = Record<string, unknown>;

export type Answer = { status: number; headers: Headers; body: unknown };

/** One server-sent event; `data` is parsed JSON, or the raw text when it is not JSON (`[DONE]`). */
export type Event = { event: string | undefined; data: unknown };

export type Streamed = {
	status: number;
	headers: Headers;
	events: Event[];
	body: unknown;
};

/** JSON headers with the target's key, or with `key` when a case sends a wrong one. */
export const headers = (target: Target, key = target.apiKey) => ({
	authorization: `Bearer ${key}`,
	"content-type": "application/json",
});

const parse = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

export async function request(
	target: Target,
	path: string,
	init: {
		method?: string;
		body?: string;
		headers?: Record<string, string>;
	} = {},
): Promise<Answer> {
	const response = await fetch(`${target.baseUrl}${path}`, {
		method: init.method ?? (init.body === undefined ? "GET" : "POST"),
		headers: init.headers ?? headers(target),
		body: init.body,
		signal: AbortSignal.timeout(target.timeoutMs),
	});
	return {
		status: response.status,
		headers: response.headers,
		body: parse(await response.text()),
	};
}

/** POSTs `body` with the target's model unless the body names one. */
export const post = (target: Target, path: string, body: Json) =>
	request(target, path, {
		body: JSON.stringify({ model: target.model, ...body }),
	});

/** POSTs a streaming request and reads every event to the end of the stream. */
export async function postStream(
	target: Target,
	path: string,
	body: Json,
): Promise<Streamed> {
	const response = await fetch(`${target.baseUrl}${path}`, {
		method: "POST",
		headers: headers(target),
		body: JSON.stringify({ model: target.model, ...body, stream: true }),
		signal: AbortSignal.timeout(target.timeoutMs),
	});
	const isStream = response.headers
		.get("content-type")
		?.includes("text/event-stream");
	if (!isStream || !response.body) {
		const body = parse(await response.text());
		return {
			status: response.status,
			headers: response.headers,
			events: [],
			body,
		};
	}
	const events: Event[] = [];
	const reader = response.body
		.pipeThrough(new TextDecoderStream() as TransformStream<Uint8Array, string>)
		.pipeThrough(new EventSourceParserStream())
		.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const data = parse(value.data);
		events.push({ event: value.event, data: data ?? value.data });
	}
	return {
		status: response.status,
		headers: response.headers,
		events,
		body: null,
	};
}

/** Pace wire and SDK fetches alike; no retry changes a recorded result. */
export function paceRequests(intervalMs: number) {
	if (intervalMs <= 0) return;
	const fetch = globalThis.fetch;
	let next = 0;
	globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
		const now = Date.now();
		const start = Math.max(now, next);
		next = start + intervalMs;
		if (start > now)
			await new Promise((resolve) => setTimeout(resolve, start - now));
		return fetch(...args);
	};
}
