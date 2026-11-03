import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Result, Status } from "./suite.ts";

/**
 * The console matrix, the result file and the comparison of two results
 * (.plans/2026-10-30-gateway-conformance.md, decision 6). A result file
 * holds per case only the status, duration, the suite's own reason and
 * whether the failure was expected: no message from the server, no output
 * of the model.
 */

export type ResultFile = {
	suite: "modus-gateway-conformance";
	date: string;
	/** `mock` when the run served the gateway core locally (`--mock`). */
	target: { baseUrl: string; model: string } | { mock: true; model: string };
	/** Where the capabilities came from, and which they were. */
	capabilities: { source: "models" | "flag" | "none"; list: string[] };
	expect: string | null;
	summary: Record<Status, number> & { expectedFailures: number; total: number };
	cases: Record<
		string,
		Omit<Result, "id" | "detail" | "expected"> & { expected?: true }
	>;
};

const label: Record<Status, string> = {
	pass: "PASS",
	fail: "FAIL",
	unsupported: "UNSUP",
};

export function line(result: Result) {
	const status =
		result.status === "fail" && result.expected
			? "XFAIL"
			: label[result.status];
	const reason = result.reason ? ` ${result.reason}` : "";
	const xpass =
		result.status === "pass" && result.expected
			? " (listed as expected to fail)"
			: "";
	return `${status.padEnd(5)} ${result.id}${reason}${xpass}${result.ms ? ` [${result.ms} ms]` : ""}`;
}

export function summarize(results: Result[]): ResultFile["summary"] {
	const summary = {
		pass: 0,
		fail: 0,
		unsupported: 0,
		expectedFailures: 0,
		total: results.length,
	};
	for (const result of results) {
		summary[result.status]++;
		if (result.status === "fail" && result.expected) summary.expectedFailures++;
	}
	return summary;
}

/** Feature × pass, fail, unsupported, in the order the cases run. */
export function matrix(results: Result[]): string {
	const rows = new Map<string, Record<Status, number>>();
	for (const result of results) {
		const row = rows.get(result.feature) ?? {
			pass: 0,
			fail: 0,
			unsupported: 0,
		};
		row[result.status]++;
		rows.set(result.feature, row);
	}
	const width = Math.max(
		7,
		...[...rows.keys()].map((feature) => feature.length),
	);
	const lines = [`${"feature".padEnd(width)}  pass  fail  unsup`];
	for (const [feature, row] of rows) {
		const cells = [row.pass, row.fail, row.unsupported].map((n) =>
			String(n || "").padStart(4),
		);
		lines.push(`${feature.padEnd(width)}  ${cells.join("  ")}`);
	}
	return lines.join("\n");
}

export function resultFile(
	results: Result[],
	meta: Pick<ResultFile, "date" | "target" | "capabilities" | "expect">,
): ResultFile {
	return {
		suite: "modus-gateway-conformance",
		...meta,
		summary: summarize(results),
		cases: Object.fromEntries(
			results.map(({ id, detail: _, expected, ...rest }) => [
				id,
				expected ? { ...rest, expected: true as const } : rest,
			]),
		),
	};
}

const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** `artifacts/gateway-conformance/<date>-<host>-<model>.json` at the repository root. */
export function defaultPath(file: ResultFile) {
	const host =
		"mock" in file.target ? "mock" : new URL(file.target.baseUrl).host;
	const name = `${file.date}-${slug(host)}-${slug(file.target.model)}.json`;
	return resolve("results", "legacy", name);
}

export async function save(file: ResultFile, path: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, "\t")}\n`);
}

/** An earlier result file, read before the run so a bad path fails at once. */
export async function load(path: string): Promise<ResultFile> {
	const file = JSON.parse(await readFile(path, "utf8")) as ResultFile;
	if (file.suite !== "modus-gateway-conformance")
		throw new Error(`${path} is not a result file`);
	return file;
}

/** The cases whose status changed since `earlier`, and the ones added or gone. */
export function compare(earlier: ResultFile, now: ResultFile): string {
	const changes: string[] = [];
	const ids = new Set([
		...Object.keys(earlier.cases),
		...Object.keys(now.cases),
	]);
	for (const id of ids) {
		const before = earlier.cases[id]?.status ?? "absent";
		const after = now.cases[id]?.status ?? "absent";
		if (before !== after) changes.push(`  ${id}: ${before} -> ${after}`);
	}
	const head = `Compared with ${earlier.date} (${earlier.summary.pass}/${earlier.summary.total} passing then, ${now.summary.pass}/${now.summary.total} now):`;
	return changes.length > 0
		? [head, ...changes].join("\n")
		: `${head} no case changed.`;
}
