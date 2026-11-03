import { STATUS_CODES } from "node:http";
import { z } from "zod";
import type { Answer, Streamed, Target } from "./http.ts";

/**
 * What a case is and how one is judged
 * (.plans/2026-10-30-gateway-conformance.md, decisions 4 to 7). A case
 * throws a `Failure` whose `reason` is written by the suite and holds no
 * content, so it may be saved; `detail` (the server's message) is printed
 * only.
 */

export type Case = {
	/** `<feature>.<what>`, unique; the feature is a row of the plan's matrix. */
	id: string;
	feature: string;
	/** Capabilities in OpenRouter's vocabulary that the model must have. */
	needs?: readonly string[];
	/** Checks a declared limit rather than a general protocol capability. */
	requiresKnownCapabilities?: boolean;
	/**
	 * Capabilities the model must lack (decision 11): the case checks what
	 * happens to a request the model cannot serve, so it runs only when the
	 * capabilities are known.
	 */
	lacks?: readonly string[];
	/** Uploads megabytes; `--skip-heavy` leaves it out (decision 11). */
	heavy?: boolean;
	run: (target: Target) => Promise<void>;
};

/** The feature of a case id: its first two segments (`chat.images.url` is `chat.images`). */
export const featureOf = (id: string) => id.split(".").slice(0, 2).join(".");

export type Status = "pass" | "fail" | "unsupported";

export type Result = {
	id: string;
	feature: string;
	status: Status;
	ms: number;
	reason?: string;
	detail?: string;
	/** Listed as a known failure for the target in `expected.ts`. */
	expected?: string;
};

export class Failure extends Error {
	readonly reason: string;
	readonly detail: string | undefined;
	constructor(reason: string, detail?: string) {
		super(reason);
		this.reason = reason;
		this.detail = detail;
	}
}

export function check(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new Failure(reason);
}

/** A value that is an identifier (an error code or class name), so it may stand in a saved reason. */
export const isIdentifier = (value: string) =>
	/^[a-z0-9_.-]{1,64}$/i.test(value);

/**
 * The error a non-2xx answer carries, as status and code only, with its
 * message as detail. A code that is not a number or an identifier is left
 * out, so no server text reaches a saved reason.
 */

export function refusal(answer: { status: number; body: unknown }): Failure {
	const error = (
		answer.body as {
			error?: { code?: unknown; type?: unknown; message?: unknown };
		}
	)?.error;
	const code = String(error?.code ?? error?.type ?? "");
	return new Failure(
		`HTTP ${answer.status}${isIdentifier(code) ? ` (${code})` : ""}`,
		typeof error?.message === "string" ? error.message : undefined,
	);
}

const errorBody = z.looseObject({
	error: z.looseObject({
		message: z.string().min(1),
		type: z.unknown().optional(),
		code: z.unknown().optional(),
	}),
});

const reasonPhrases = new Set(
	Object.values(STATUS_CODES).map((phrase) => phrase?.toLowerCase()),
);

/** Text that parses as a JSON object or array, such as an upstream's error passed on as a string. */
const isJson = (text: string) => {
	if (!/^\s*[[{]/.test(text)) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
};

/**
 * An error a client can read (decision 11): `application/json`, an
 * `error.message`, an `error.type` or `error.code` to branch on, and a
 * message that says more than the HTTP reason phrase and is not an
 * upstream's JSON serialised into a string. OpenRouter's code is a number
 * and OpenAI's a string; either counts.
 */
export function checkErrorBody(answer: { headers: Headers; body: unknown }) {
	check(
		answer.headers.get("content-type")?.includes("application/json"),
		"error is not application/json",
	);
	const { error } = shape(answer.body, errorBody, "error body");
	const named = (value: unknown) =>
		(typeof value === "string" && value.length > 0) ||
		typeof value === "number";
	check(
		named(error.type) || named(error.code),
		"error has neither type nor code",
	);
	check(
		!reasonPhrases.has(error.message.trim().toLowerCase()),
		"error.message is only the HTTP reason phrase",
	);
	check(!isJson(error.message), "error.message is serialised JSON");
}

/**
 * The statuses that refuse a request for what it asks: bad request, no
 * route for it, too large, unsupported media, unprocessable. A 401, 402,
 * 403 or 429 refuses the caller, not the request, so it proves nothing.
 */
const refusals = new Set([400, 404, 413, 415, 422]);

/** A refusal of the request in the error shape; any other status fails the case. */
export function checkRefused(answer: Answer) {
	if (!refusals.has(answer.status)) throw refusal(answer);
	checkErrorBody(answer);
}

/**
 * For a request a conformant server may serve or refuse: a 200 parsed with
 * `schema` and handed to `served`, or a refusal (`checkRefused`). A 5xx, a
 * timeout or an error body a client cannot read fails the case.
 */
export async function servedOrRefused<T>(
	answer: Answer,
	schema: z.ZodType<T>,
	what: string,
	served: (value: T) => void | Promise<void>,
) {
	if (answer.status === 200) return served(shape(answer.body, schema, what));
	checkRefused(answer);
}

/** The body of a 200 answer, parsed with `schema`; anything else fails the case. */
export function ok<T>(answer: Answer, schema: z.ZodType<T>, what: string): T {
	if (answer.status !== 200) throw refusal(answer);
	return shape(answer.body, schema, what);
}

/** The events of a 200 event stream; anything else fails the case. */
export function okStream(streamed: Streamed): Streamed {
	if (streamed.status !== 200) throw refusal(streamed);
	check(streamed.events.length > 0, "answer is not an event stream");
	return streamed;
}

/** `value` parsed with `schema`, or a failure naming the first paths that do not fit. */
export function shape<T>(
	value: unknown,
	schema: z.ZodType<T>,
	what: string,
): T {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	const paths = parsed.error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
	throw new Failure(`${what} has the wrong shape (${paths.join("; ")})`);
}

/** Parses JSON text a model produced, failing the case when it is not JSON. */
export function json(text: string | null | undefined, what: string): unknown {
	try {
		return JSON.parse(text ?? "");
	} catch {
		throw new Failure(`${what} is not valid JSON`);
	}
}

export async function runCases(
	cases: readonly Case[],
	target: Target,
	options: {
		capabilities: ReadonlySet<string> | null;
		expected: Readonly<Record<string, string>>;
		concurrency: number;
		onResult: (result: Result) => void;
	},
): Promise<Result[]> {
	const results: Result[] = [];
	const queue = [...cases];
	const runOne = async (testCase: Case): Promise<Result> => {
		const base = { id: testCase.id, feature: testCase.feature };
		if (testCase.requiresKnownCapabilities && !options.capabilities)
			return {
				...base,
				status: "unsupported",
				ms: 0,
				reason: "needs advertised model metadata",
			};
		const missing = (testCase.needs ?? []).filter(
			(need) => !options.capabilities?.has(need),
		);
		if (options.capabilities && missing.length > 0) {
			return {
				...base,
				status: "unsupported",
				ms: 0,
				reason: `needs ${missing.join(", ")}`,
			};
		}
		if (testCase.lacks?.length && !options.capabilities) {
			return {
				...base,
				status: "unsupported",
				ms: 0,
				reason: "needs known capabilities",
			};
		}
		const present = (testCase.lacks ?? []).filter((lack) =>
			options.capabilities?.has(lack),
		);
		if (present.length > 0) {
			const reason = `needs a model without ${present.join(", ")}`;
			return { ...base, status: "unsupported", ms: 0, reason };
		}
		const started = performance.now();
		const ms = () => Math.round(performance.now() - started);
		const expected = options.expected[testCase.id];
		try {
			await testCase.run(target);
			return { ...base, status: "pass", ms: ms(), expected };
		} catch (error) {
			const failure =
				error instanceof Failure
					? error
					: new Failure(
							error instanceof Error && error.name === "TimeoutError"
								? "timed out"
								: "request failed",
							error instanceof Error ? error.message : String(error),
						);
			return {
				...base,
				status: "fail",
				ms: ms(),
				reason: failure.reason,
				detail: failure.detail,
				expected,
			};
		}
	};
	const worker = async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			const result = await runOne(next);
			results.push(result);
			options.onResult(result);
		}
	};
	await Promise.all(Array.from({ length: options.concurrency }, worker));
	const order = new Map(cases.map((testCase, index) => [testCase.id, index]));
	return results.sort(
		(a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
	);
}
