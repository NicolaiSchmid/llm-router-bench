import { z } from "zod";
import { request, type Target } from "./http.ts";

/** The parts of an OpenRouter model entry the suite reads capabilities from. */
export const capabilityEntry = z.looseObject({
	id: z.string(),
	architecture: z.looseObject({ input_modalities: z.array(z.string()) }),
	supported_parameters: z.array(z.string()),
	pricing: z.looseObject({ input_cache_read: z.string().nullish() }).nullish(),
});

type ModelEntry = { id?: unknown; [key: string]: unknown };
const lists = new Map<string, Promise<ModelEntry[]>>();

/**
 * The entries of the target's `GET /models`, or an empty list when it does
 * not answer one; fetched once per base URL, as OpenRouter's is about a
 * megabyte. The cases that check the endpoint itself request it directly.
 */
export function listModels(target: Target): Promise<ModelEntry[]> {
	let list = lists.get(target.baseUrl);
	if (!list) {
		list = request(target, "/models").then(
			(answer) => {
				const data = (answer.body as { data?: unknown } | null)?.data;
				return Array.isArray(data) ? data : [];
			},
			() => [],
		);
		lists.set(target.baseUrl, list);
	}
	return list;
}

/** The target's `/models` entry for the model under test, if it lists one. */
export const findModel = async (target: Target) =>
	(await listModels(target)).find((model) => model.id === target.model);

/**
 * The model's capabilities in OpenRouter's vocabulary
 * (.plans/2026-10-30-gateway-conformance.md, decision 5): its
 * `supported_parameters`, its input modalities other than text, and
 * `caching` when it has a cache-read price. Null when `/models` does not
 * describe the model, in which case every case runs.
 */
export async function discoverCapabilities(
	target: Target,
): Promise<Set<string> | null> {
	const entry = await findModel(target);
	const parsed = capabilityEntry.safeParse(entry);
	if (!parsed.success) return null;
	const { supported_parameters, architecture, pricing } = parsed.data;
	const capabilities = new Set([
		...supported_parameters,
		...architecture.input_modalities.filter((modality) => modality !== "text"),
	]);
	const transports = (
		entry?.architecture as { input_image_transports?: unknown } | undefined
	)?.input_image_transports;
	if (
		capabilities.has("image") &&
		(!Array.isArray(transports) || transports.includes("https"))
	)
		capabilities.add("image_url");
	const dialect = entry?.json_schema_dialect as
		| { optional_properties?: boolean; unconstrained_subschemas?: boolean }
		| undefined;
	if (dialect?.optional_properties !== false)
		capabilities.add("json_schema_optional");
	if (dialect?.unconstrained_subschemas !== false)
		capabilities.add("json_schema_unconstrained");
	const limit = (
		entry?.gateway_limits as { input_characters?: unknown } | undefined
	)?.input_characters;
	if (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0)
		capabilities.add("gateway_input_limit");
	else capabilities.add("native_context_overflow");
	if (Number(pricing?.input_cache_read ?? 0) > 0) capabilities.add("caching");
	return capabilities;
}
