import { EventSourceParserStream } from "eventsource-parser/stream";
import { check } from "./conformance/suite.ts";
/** A native Messages stream must carry coherent SSE payloads, not matching words. */
export async function checkMessagesStream(response: Response) {
	check(
		response.headers.get("content-type")?.includes("text/event-stream"),
		"not an event stream",
	);
	check(response.body, "missing event stream body");
	const reader = response.body
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(new EventSourceParserStream())
		.getReader();
	let started = false,
		stopped = false,
		delta = false,
		stopReason = false,
		text = false;
	const active = new Set<number>();
	const seen = new Set<number>();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const data = JSON.parse(value.data) as {
			type?: string;
			index?: number;
			message?: { type?: string; role?: string };
			delta?: { type?: string; text?: string; stop_reason?: string };
		};
		check(data.type === value.event, "event payload type mismatch");
		check(!stopped, "event after message_stop");
		if (data.type === "ping") continue;
		if (data.type === "message_start") {
			check(
				!started &&
					data.message?.type === "message" &&
					data.message.role === "assistant",
				"invalid message_start",
			);
			started = true;
			continue;
		}
		check(started, "event before message_start");
		if (data.type === "content_block_start") {
			check(
				Number.isInteger(data.index) && !seen.has(data.index ?? -1) && !delta,
				"invalid block start",
			);
			active.add(data.index as number);
			seen.add(data.index as number);
		} else if (data.type === "content_block_delta") {
			check(
				active.has(data.index ?? -1) && data.delta?.type,
				"delta outside a content block",
			);
			if (data.delta?.type === "text_delta") {
				check(typeof data.delta.text === "string", "invalid text delta");
				text ||= data.delta.text.length > 0;
			}
		} else if (data.type === "content_block_stop") {
			check(active.delete(data.index ?? -1), "stop outside a content block");
		} else if (data.type === "message_delta") {
			check(
				active.size === 0 && data.delta && typeof data.delta === "object",
				"invalid message_delta",
			);
			delta = true;
			stopReason ||=
				typeof data.delta?.stop_reason === "string" &&
				data.delta.stop_reason.length > 0;
		} else if (data.type === "message_stop") {
			check(active.size === 0 && delta && stopReason, "premature message_stop");
			stopped = true;
		} else check(false, "unexpected message event");
	}
	check(started && stopped && text, "incomplete native text stream");
}
