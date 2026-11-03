#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCases } from "./cases.ts";
import { config, packageRoot } from "./config.ts";
import { dependencyVersions } from "./dependency-versions.ts";
import { instrument, measure } from "./measure.ts";
import { type Run, runSchema } from "./model.ts";

const sha = (s: string | Buffer) =>
	createHash("sha256").update(s).digest("hex");
async function main() {
	const c = config(process.argv.slice(2));
	const start = new Date();
	const pkg = JSON.parse(
		await readFile(join(packageRoot, "package.json"), "utf8"),
	) as { version: string; dependencies: Record<string, string> };
	const versions = await dependencyVersions(Object.keys(pkg.dependencies));
	let commit = "unknown",
		lockfile = "unknown";
	try {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: packageRoot,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		if (top !== packageRoot.replace(/\/$/, ""))
			throw new Error("Installed package is not the source checkout");
		commit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: packageRoot,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		const dirty = execFileSync(
			"git",
			[
				"status",
				"--porcelain",
				"--",
				"src",
				"providers",
				"package.json",
				"package-lock.json",
			],
			{ cwd: packageRoot },
		).toString();
		if (dirty) commit += ":dirty";
		lockfile = sha(await readFile(join(packageRoot, "package-lock.json")));
	} catch {
		try {
			const release = JSON.parse(
				await readFile(join(packageRoot, "dist/provenance.json"), "utf8"),
			) as { suiteCommit: string; lockfileSha256: string };
			commit = release.suiteCommit;
			lockfile = release.lockfileSha256;
		} catch {
			/* Explicit unknown provenance rather than the consumer's git revision. */
		}
	}
	const transport = instrument(c);
	const cases = buildCases(c);
	const run: Run = {
		schemaVersion: 1,
		runId: `${start.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
		start: start.toISOString(),
		end: start.toISOString(),
		suiteVersion: pkg.version,
		suiteCommit: commit,
		lockfileSha256: lockfile,
		caseSetSha256: sha(
			JSON.stringify(
				cases.map((x) => ({
					id: x.id,
					contract: x.contract,
					skip: x.skip ?? false,
				})),
			),
		),
		sdkVersions: versions,
		target: {
			provider: c.provider.id,
			baseUrl: c.baseUrl,
			model: c.model,
			protocol: c.protocol,
			backend: "unknown",
		},
		settings: {
			suite: c.suite,
			repetitions: c.repetitions,
			maxRequests: c.maxRequests,
			maxOutputTokens: c.maxOutputTokens,
			timeoutMs: c.timeoutMs,
			intervalMs: c.intervalMs,
			concurrency: 1,
			retries: 0,
			routePolicy: c.routePolicy,
			runner: `${process.platform}/${process.arch} node ${process.version}`,
			region: c.region,
		},
		completion: "complete",
		attempts: [],
	};
	const savedError = console.error,
		savedWarn = console.warn;
	console.error = () => {};
	console.warn = () => {};
	try {
		outer: for (let n = 1; n <= c.repetitions; n++)
			for (const testCase of cases) {
				const result = await measure(testCase, n);
				run.attempts.push(result);
				console.log(
					`${result.state === "skipped" ? "SKIP" : (result.outcome?.toUpperCase() ?? "ABORT")} ${testCase.id} (${result.category})`,
				);
				if (result.category === "configuration") {
					run.completion = "invalid";
					break outer;
				}
				if (result.state === "aborted") {
					run.completion = "partial";
					break outer;
				}
			}
	} finally {
		transport.restore();
		console.error = savedError;
		console.warn = savedWarn;
		run.end = new Date().toISOString();
		const file = runSchema.parse(run);
		const dir = join(
			c.out,
			start.toISOString().slice(0, 4),
			start.toISOString().slice(5, 7),
			run.runId,
		);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "run.json"),
			`${JSON.stringify(file, null, 2)}\n`,
			{ flag: "wx" },
		);
		console.log(
			`Saved ${dir}/run.json; ${transport.used()} requests; ${run.completion}`,
		);
	}
	if (
		run.completion !== "complete" ||
		run.attempts.some((a) => a.outcome === "fail")
	)
		process.exitCode = 1;
}
main().catch(() => {
	console.error(
		"Run could not start or save. Check provider, model, key, options, and writable output directory. Server messages and credentials are intentionally omitted.",
	);
	process.exitCode = 2;
});
