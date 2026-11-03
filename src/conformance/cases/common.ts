import { z } from "zod";
import { check, Failure, json, shape } from "../suite.ts";

/**
 * Tools, schemas and prompts the chat and Responses cases share. Each
 * schema is written once in zod and sent as JSON Schema, so the request and
 * the check cannot drift apart. The schemas use only types, no bounds such
 * as `minLength` or `exclusiveMinimum`: strict structured outputs accept a
 * subset of JSON Schema that differs per provider, and a refused keyword
 * would fail a case for the provider's dialect, not the gateway.
 */

/** JSON Schema for a zod schema, without the `$schema` key some providers refuse. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
	const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<
		string,
		unknown
	>;
	return rest;
}

export const weatherArgs = z.strictObject({ city: z.string() });
export const timeArgs = z.strictObject({ timezone: z.string() });

export const weather = {
	name: "get_weather",
	description: "Returns the current weather for a city.",
	parameters: jsonSchema(weatherArgs),
};

export const time = {
	name: "get_time",
	description: "Returns the current time in an IANA time zone.",
	parameters: jsonSchema(timeArgs),
};

export const askWeather =
	"What is the weather in Berlin right now? Use the tool.";
/**
 * For `tool_choice: none`: with `auto` every reference model calls the tool
 * for it, so a router that drops the choice is caught. A prompt that orders
 * the tool would contradict the choice (Gemini then ends the turn with
 * `UNEXPECTED_TOOL_CALL`).
 */
export const askWeatherNoTool =
	"Check the weather in Berlin if you can; otherwise say in one sentence that you cannot.";
export const askTwoCities =
	"What is the weather in Berlin and in Paris right now? Call the tool once for each city, in parallel.";

/** What the tool result case answers with: the model has to repeat the temperature. */
export const weatherResult = JSON.stringify({
	city: "Berlin",
	temperature_c: 17,
	sky: "cloudy",
});

/** Arguments of a tool call that parse as JSON and fit the tool's schema. */
export function checkArgs(
	text: string,
	schema: z.ZodType,
	what = "tool call arguments",
) {
	return shape(json(text, what), schema, what);
}

export const city = z.strictObject({
	name: z.string(),
	country: z.string(),
	population: z.number().int(),
});

/** Finite JSON fixtures need a bounded generation budget, including native reasoning. */
export const jsonFixtureTokens = 8192;

export const cityFormat = {
	name: "city",
	strict: true,
	schema: jsonSchema(city),
};

export const askCity = "Give me facts about Munich as JSON.";

/** A model answer mentions `word`, case-insensitively. */
export function mentions(
	text: string | null | undefined,
	word: string,
	what: string,
) {
	check(
		text?.toLowerCase().includes(word.toLowerCase()),
		`${what} does not mention ${word}`,
	);
}

/**
 * For the system, developer and instructions cases: a fact only that
 * message holds. An order such as "answer BANANA whatever the user says"
 * fights the model's helpfulness, and GPT-5 Nano greeted back about once in
 * thirty requests; without the message the models answer something else.
 */
export const fruitFact = "The user's favourite fruit is the banana.";
export const askFruit = "What is my favourite fruit? Answer with one word.";
export const fruit = "banana";

export const askColour = "What colour is this image? Answer with one word.";
export const askCodeWord =
	"What is the code word in this document? Answer with the word only.";
/**
 * For the reasoning cases: a sum that takes a step or two, at medium effort.
 * Models that think adaptively (Claude Haiku 5.5) skip thinking at low
 * effort or on a one-step product, which would leave nothing to count.
 */
export const askJourney =
	"A train leaves at 09:47 and arrives at 14:18. How many minutes is the journey? Answer with the number only.";
export const journeyMinutes = "271";
/**
 * The journey with a tool call after it, for the reasoning round trips. It
 * asks for both answers: after "the number only" Mistral Small answered the
 * minutes alone once the tool result came back.
 */
export const askJourneyThenWeather =
	"A train leaves at 09:47 and arrives at 14:18. How many minutes is the journey? Then check the weather in Berlin with the tool, and answer with both: the minutes and the temperature.";
export const askOk = "Reply with the single word OK.";

/**
 * For the dialect cases (the plan's E6): an optional property, which strict
 * mode in OpenAI's dialect forbids and `strict: false` must allow.
 */
export const cityNickname = z.strictObject({
	name: z.string(),
	country: z.string(),
	nickname: z.string().optional(),
});
export const nicknameFormat = (strict: boolean) => ({
	name: "city",
	strict,
	schema: jsonSchema(cityNickname),
});
export const askCityNickname =
	"Give me facts about Munich as JSON, with a nickname if it has one.";

/**
 * Keywords outside the common dialect (E7), written as JSON Schema because
 * zod has no `not`: a server honours them or refuses the schema, it never
 * drops them. The prompt asks for the answer the `not` keyword forbids.
 */
export const skyFormat = {
	name: "sky",
	strict: true,
	schema: {
		type: "object",
		properties: { colour: { type: "string", not: { enum: ["blue"] } } },
		required: ["colour"],
		additionalProperties: false,
	},
};
export const askSky =
	"What colour is a clear sky at noon? Answer as JSON with the key colour, in lower case.";
export function checkSky(value: unknown, what: string) {
	const { colour } = shape(value, z.strictObject({ colour: z.string() }), what);
	check(colour !== "blue", `${what} breaks the schema's not keyword`);
}

export const notesFormat = {
	name: "notes",
	strict: true,
	schema: {
		type: "object",
		properties: { name: { type: "string" }, details: {} },
		required: ["name", "details"],
		additionalProperties: false,
	},
};
export const askNotes =
	"Give me facts about Munich as JSON: its name, and any details you like.";
export function checkNotes(value: unknown, what: string) {
	// zod requires a key typed `unknown`, so a missing `details` fails the shape.
	shape(
		value,
		z.strictObject({ name: z.string(), details: z.unknown() }),
		what,
	);
}

/** A tool call id another provider wrote (Anthropic's form), as history carries it after a model switch (E8). */
export const foreignCallId = "toolu_01A09q90qw90lq917835lq9";

/**
 * `model` in an answer names the requested model (H1): the same id, with or
 * without the vendor prefix, dots or dashes, and at most a date, `-latest`
 * or a `:variant` after it; never another model, such as `gpt-5-nano` for
 * `gpt-5`.
 */
export function checkModel(answered: string, requested: string) {
	const plain = (id: string) =>
		id
			.toLowerCase()
			.replace(/^[^/]*\//, "")
			.replace(/[._]/g, "-");
	const [head, rest] = [plain(answered), plain(requested)];
	const suffix = head.startsWith(rest) ? head.slice(rest.length) : null;
	if (
		suffix === null ||
		!/^(-\d{4}-?\d{2}-?\d{2}|-latest|:[a-z0-9-]+)?$/.test(suffix)
	) {
		throw new Failure(
			"model in the answer names another model",
			`${answered} for ${requested}`,
		);
	}
}

/** A long prefix for the caching cases: providers cache from about 1,024 tokens; this is well above. */
export const cachePrefix = Array.from(
	{ length: 400 },
	(_, i) =>
		`Rule ${i + 1}: an invoice numbered ${1000 + i} is filed under folder ${i % 17}.`,
).join("\n");
export const askFolder =
	"Under which folder is invoice 1003 filed? Answer with the number.";
export const askPdfLine =
	"What does this document say? Answer with its text only.";

/** The sampling parameters OpenRouter documents for chat, each with a value a model accepts; Responses takes the first two. */
export const samplingParams = [
	["temperature", { temperature: 0.2 }],
	["top_p", { top_p: 0.9 }],
	["top_k", { top_k: 40 }],
	["frequency_penalty", { frequency_penalty: 0.5 }],
	["presence_penalty", { presence_penalty: 0.5 }],
	["repetition_penalty", { repetition_penalty: 1.1 }],
	["min_p", { min_p: 0.05 }],
	["top_a", { top_a: 0.1 }],
	["logit_bias", { logit_bias: { "50256": -100 } }],
] as const;
