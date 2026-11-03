import { z } from "zod";
import { capabilityEntry, findModel, listModels } from "../capabilities.ts";
import {
	type Answer,
	headers,
	type Json,
	post,
	postStream,
	request,
	type Target,
} from "../http.ts";
import { completion, response } from "../shapes.ts";
import { type Case, check, checkErrorBody, ok, shape } from "../suite.ts";
import { askOk } from "./common.ts";

/**
 * Errors (status and shape), size limits and the models endpoint, from the
 * plan's matrix and its edge cases from production
 * (.plans/2026-10-30-gateway-conformance.md). Every error must be one a
 * client can read (`checkErrorBody`).
 */

function checkError(answer: Answer, statuses: readonly number[]) {
	check(
		statuses.includes(answer.status),
		`answered ${answer.status}, not ${statuses.join(" or ")}`,
	);
	checkErrorBody(answer);
}

/**
 * A prompt half again as long as the model's context window: digits apart,
 * about one token each in the reference models' tokenizers. The window comes
 * from `context_length` in `/models`, or is taken as the largest common one.
 */
const digits = Array.from(
	{ length: 1000 },
	(_, i) => ` ${(i * 7919) % 10}`,
).join("");
const prompts = new Map<number, string>();

async function overContext(target: Target): Promise<string> {
	const window = Number((await findModel(target))?.context_length);
	const tokens = Math.ceil(
		(Number.isFinite(window) && window > 0 ? window : 2_000_000) * 1.5,
	);
	const prompt = prompts.get(tokens) ?? digits.repeat(Math.ceil(tokens / 1000));
	prompts.set(tokens, prompt);
	return prompt;
}

const contextStatuses = [400, 413];

/** A body of 5 MiB that costs no tokens: the request with whitespace before its last brace. */
const padding = " ".repeat(5 * 1024 * 1024);
export const padded = (target: Target, body: Json) =>
	`${JSON.stringify({ model: target.model, ...body }).slice(0, -1)}${padding}}`;

const endpoints = [
	[
		"chat",
		"/chat/completions",
		{ messages: [{ role: "user", content: askOk }] },
	],
	["responses", "/responses", { input: askOk }],
] as const;

const errorCase = (
	id: string,
	statuses: readonly number[],
	send: (target: Target) => Promise<Answer>,
): Case => ({
	id,
	feature: "errors.shape",
	run: async (target) => checkError(await send(target), statuses),
});

/** POSTs a body as given, not JSON-encoded and without the target's model. */
const postRaw = (
	target: Target,
	path: string,
	body: string,
	key = target.apiKey,
) => request(target, path, { body, headers: headers(target, key) });

/**
 * A model that takes a chat request: text among its output modalities, or,
 * in a list that names none (the gateway's), an id that is not an embedding
 * model's.
 */
export const answersText = (model: Json) => {
	const architecture = model.architecture as
		| { output_modalities?: unknown; input_modalities?: unknown }
		| undefined;
	const outputs = architecture?.output_modalities;
	const inputs = architecture?.input_modalities;
	const endpoints = model.supported_endpoints;
	if (Array.isArray(inputs) && !inputs.includes("text")) return false;
	if (Array.isArray(endpoints) && !endpoints.includes("/chat/completions"))
		return false;
	return Array.isArray(outputs)
		? outputs.includes("text")
		: !String(model.id).includes("embed");
};

const modelEntry = z.looseObject({ id: z.string().min(1) });
const modelList = z.looseObject({ data: z.array(modelEntry).min(1) });

export const errorCases: Case[] = [
	...endpoints.flatMap(([name, path, body]) => [
		errorCase(`errors.shape.${name}-missing-key`, [401], (target) =>
			request(target, path, {
				body: JSON.stringify({ model: target.model, ...body }),
				headers: { "content-type": "application/json" },
			}),
		),
		errorCase(`errors.shape.${name}-invalid-key`, [401], (target) =>
			postRaw(
				target,
				path,
				JSON.stringify({ model: target.model, ...body }),
				"sk-conformance-invalid",
			),
		),
		errorCase(`errors.shape.${name}-unknown-model`, [400, 404], (target) =>
			post(target, path, { ...body, model: "conformance/no-such-model" }),
		),
		errorCase(`errors.shape.${name}-malformed-json`, [400], (target) =>
			postRaw(target, path, '{"model": '),
		),
	]),
	errorCase("errors.shape.chat-missing-messages", [400, 422], (target) =>
		post(target, "/chat/completions", {}),
	),
	errorCase("errors.shape.responses-missing-input", [400, 422], (target) =>
		post(target, "/responses", {}),
	),
	errorCase("errors.shape.chat-wrong-type", [400, 422], (target) =>
		post(target, "/chat/completions", {
			...endpoints[0][2],
			temperature: "hot",
		}),
	),
	{
		id: "errors.before-stream.chat",
		feature: "errors.before-stream",
		run: async (target) => {
			const streamed = await postStream(target, "/chat/completions", {
				model: "conformance/no-such-model",
				...endpoints[0][2],
			});
			check(
				streamed.events.length === 0,
				"a bad request answered with an event stream",
			);
			check(
				streamed.status === 400 || streamed.status === 404,
				`answered ${streamed.status}`,
			);
			checkErrorBody(streamed);
		},
	},
	...endpoints.flatMap(([name, path, body]): Case[] => {
		const whole: z.ZodType = name === "chat" ? completion : response;
		const input = async (target: Target): Promise<Json> => {
			const prompt = await overContext(target);
			return name === "chat"
				? { messages: [{ role: "user", content: prompt }] }
				: { input: prompt };
		};
		return [
			...([false, true] as const).map(
				(stream): Case => ({
					id: `errors.input-limit.${name}${stream ? "-stream" : ""}`,
					feature: "errors.input-limit",
					heavy: true,
					run: async (target) => {
						const entry = await findModel(target);
						const limit = Number(
							(
								entry?.gateway_limits as
									| { input_characters?: unknown }
									| undefined
							)?.input_characters,
						);
						check(
							Number.isSafeInteger(limit) && limit > 0,
							"no valid advertised input limit",
						);
						const text = "x".repeat(limit + 1);
						const body =
							name === "chat"
								? { messages: [{ role: "user", content: text }], stream }
								: { input: text, stream };
						checkError(await post(target, path, body), [413]);
					},
				}),
			),
			{
				id: `errors.context-length.${name}`,
				feature: "errors.context-length",
				needs: ["native_context_overflow"],
				heavy: true,
				run: async (target) =>
					checkError(
						await post(target, path, await input(target)),
						contextStatuses,
					),
			},
			{
				id: `errors.context-length.${name}-stream`,
				feature: "errors.context-length",
				needs: ["native_context_overflow"],
				heavy: true,
				run: async (target) => {
					const streamed = await postStream(target, path, await input(target));
					check(
						streamed.events.length === 0,
						"an over-long prompt answered with an event stream",
					);
					checkError(streamed, contextStatuses);
				},
			},
			{
				id: `errors.body-limit.${name}`,
				feature: "errors.body-limit",
				heavy: true,
				run: async (target) => {
					const answer = await request(target, path, {
						body: padded(target, body),
					});
					if (answer.status === 200) shape(answer.body, whole, name);
					else checkError(answer, [413]);
				},
			},
		];
	}),
	{
		id: "models.list.includes-model",
		feature: "models.list",
		run: async (target) => {
			const answer = await request(target, "/models");
			check(answer.status === 200, `answered ${answer.status}`);
			const list = shape(answer.body, modelList, "model list");
			check(
				list.data.some((model) => model.id === target.model),
				"the model under test is not listed",
			);
		},
	},
	{
		id: "models.list.ids-routable",
		feature: "models.list",
		run: async (target) => {
			// Up to three other ids of the model's family (`google/gemini`, `anthropic/claude`), the
			// cheapest the list prices, each asked for one short answer: a router whose list and
			// routing table disagree on an id (a dot for a dash) answers 400 or 404 for it.
			// The vendor and the first part of the name (`x-ai/grok-4` is `x-ai/grok`).
			const family = target.model.match(/^[^/]+\/[^-:.]+/)?.[0] ?? target.model;
			const price = (model: Json) => {
				const pricing = model.pricing as
					| { prompt?: unknown; completion?: unknown }
					| undefined;
				const sum =
					Number(pricing?.prompt ?? 0) + Number(pricing?.completion ?? 0);
				return Number.isFinite(sum) && sum >= 0
					? sum
					: Number.POSITIVE_INFINITY;
			};
			const listed = (await listModels(target)).filter(
				(model): model is Json & { id: string } =>
					typeof model.id === "string" &&
					model.id !== target.model &&
					// Variants (`:free`) route like their model.
					!model.id.includes(":") &&
					answersText(model),
			);
			// A short list (the gateway's) has no families: then any other id will do.
			const kin = listed.filter((model) => model.id.startsWith(family));
			const others = (kin.length > 0 ? kin : listed)
				.sort((a, b) => price(a) - price(b))
				.slice(0, 3);
			check(others.length > 0, "the list shows no other model");
			const answers = await Promise.all(
				others.map((other) =>
					post(target, "/chat/completions", {
						model: other.id,
						messages: [{ role: "user", content: askOk }],
						// Room for a reasoning model's minimum budget; one word is asked for.
						max_tokens: 256,
					}),
				),
			);
			for (const answer of answers) ok(answer, completion, "completion");
		},
	},
	{
		id: "models.capabilities.described",
		feature: "models.capabilities",
		run: async (target) => {
			const answer = await request(target, "/models");
			check(answer.status === 200, `answered ${answer.status}`);
			const entry = shape(answer.body, modelList, "model list").data.find(
				(model) => model.id === target.model,
			);
			check(entry, "the model under test is not listed");
			shape(entry, capabilityEntry, "model entry");
		},
	},
];
