import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type Attempt, type Run, runSchema } from "./model.ts";
export async function loadRuns(
	root: string,
): Promise<{ run: Run; file: string }[]> {
	const files: string[] = [];
	async function visit(dir: string) {
		for (const e of await readdir(dir, { withFileTypes: true })) {
			if (e.isDirectory()) await visit(join(dir, e.name));
			else if (e.name === "run.json") files.push(join(dir, e.name));
		}
	}
	try {
		await visit(root);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	return Promise.all(
		files.sort().map(async (file) => ({
			file,
			run: runSchema.parse(JSON.parse(await readFile(file, "utf8"))),
		})),
	);
}
export function wilson(failures: number, n: number): [number, number] | null {
	if (!n) return null;
	const z = 1.96,
		p = failures / n,
		d = 1 + (z * z) / n,
		m = (p + (z * z) / (2 * n)) / d,
		h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
	return [Math.max(0, m - h), Math.min(1, m + h)];
}
export function metrics(run: Run) {
	const eligible = run.completion === "complete";
	const applicable = eligible
		? run.attempts.filter((a) => a.state === "completed")
		: [];
	const positive =
		run.settings.suite === "core"
			? applicable.filter((a) => a.assertion === "positive")
			: [];
	const requests = positive.flatMap((a) =>
		a.requests.filter((r) => r.failure !== "budget"),
	);
	const errors = requests.filter(
		(r) => r.failure || (r.status ?? 0) >= 400,
	).length;
	return {
		eligible,
		compatibility: {
			failed: applicable.filter((a) => a.outcome === "fail").length,
			total: applicable.length,
		},
		reliability: {
			errors,
			total: requests.length,
			rateLimits: requests.filter((r) => r.status === 429).length,
			ci95: wilson(errors, requests.length),
		},
		skipped: run.attempts.filter((a) => a.state === "skipped").length,
	};
}
export function support(attempts: Attempt[]) {
	const executed = attempts.filter((a) => a.state === "completed");
	if (!executed.length) return "untested";
	if (executed.every((a) => a.outcome === "pass")) return "observed pass";
	if (executed.some((a) => a.outcome === "pass")) return "partial";
	if (executed.every((a) => a.category === "unsupported")) return "refused";
	return "observed failure";
}
const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);
export async function report(root = "results", out = "site") {
	const data = await loadRuns(root);
	const latest = new Map<string, (typeof data)[number]>();
	for (const item of data) {
		const r = item.run;
		const key = JSON.stringify([
			r.target,
			r.settings.suite,
			r.settings.maxOutputTokens,
			r.caseSetSha256,
			r.sdkVersions,
		]);
		const previous = latest.get(key);
		if (!previous || r.end > previous.run.end) latest.set(key, item);
	}
	const columns = [...latest.values()];
	const features = [
		...new Set(
			columns.flatMap(({ run }) =>
				run.attempts.map((a) => `${a.layer}/${a.sdk ?? "wire"}/${a.feature}`),
			),
		),
	].sort();
	const matrix = columns.length
		? `<div style="overflow:auto"><table><caption>Latest observation per target and test configuration</caption><thead><tr><th>Feature</th>${columns.map(({ run }) => `<th>${escapeHtml(run.target.provider)}<br>${escapeHtml(run.target.model)}<br>${escapeHtml(run.target.protocol)} · ${escapeHtml(run.settings.suite)}<br>${escapeHtml(run.end.slice(0, 10))}</th>`).join("")}</tr></thead><tbody>${features.map((f) => `<tr><th>${escapeHtml(f)}</th>${columns.map(({ run }) => `<td>${run.completion === "complete" ? support(run.attempts.filter((a) => `${a.layer}/${a.sdk ?? "wire"}/${a.feature}` === f)) : "incomplete sample"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
		: "";
	const rows = data.map(({ run, file }) => {
		const m = metrics(run);
		const percentage = m.reliability.total
			? `${((100 * m.reliability.errors) / m.reliability.total).toFixed(1)}%`
			: "—";
		const groups = new Map<string, Attempt[]>();
		for (const a of run.attempts) {
			const k = `${a.layer}/${a.sdk ?? "wire"}/${a.feature}`;
			groups.set(k, [...(groups.get(k) ?? []), a]);
		}
		return `<article><h2>${escapeHtml(run.target.provider)} · ${escapeHtml(run.target.model)} · ${escapeHtml(run.target.protocol)}</h2><p>${escapeHtml(run.start)} · ${escapeHtml(run.completion)} · ${escapeHtml(run.settings.suite)} · ${Date.now() - Date.parse(run.end) > 8 * 86400000 ? "STALE" : "recent"} · <a href="${escapeHtml(relative(out, file))}">run evidence</a></p><p>Compatibility failures: ${m.compatibility.failed}/${m.compatibility.total}; request errors: ${m.reliability.errors}/${m.reliability.total} (${percentage}, including ${m.reliability.rateLimits} rate limits). Skipped: ${m.skipped}. ${m.eligible ? "" : "Excluded from headline metrics."}</p><table><thead><tr><th>Layer / SDK / feature</th><th>Observation</th><th>Pass / completed</th></tr></thead><tbody>${[...groups].map(([k, a]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(support(a))}</td><td>${a.filter((x) => x.outcome === "pass").length}/${a.filter((x) => x.state === "completed").length}</td></tr>`).join("")}</tbody></table><details><summary>Versions and settings</summary><pre>${escapeHtml(JSON.stringify({ suite: run.suiteCommit, caseSet: run.caseSetSha256, sdks: run.sdkVersions, settings: run.settings, requestErrorCI95: m.reliability.ci95 }, null, 2))}</pre></details></article>`;
	});
	await mkdir(out, { recursive: true });
	await writeFile(
		join(out, "index.html"),
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>llm-router-bench</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:0 20px;color:#18202a;background:#fafaf8}article{margin:32px 0;padding:20px;border:1px solid #ccc}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid #ddd}pre{overflow:auto}a{color:#293dc4}</style><h1>llm-router-bench</h1><p>Measured API and SDK compatibility. Authored by MODUS. Synthetic workloads; results describe the tested endpoint, model, protocol, SDK version, and window. Request rates are not provider-wide uptime. Different case sets and SDK versions are separate series.</p><p>Legacy diagnostics have no reliability denominator. Expected negative requests are excluded from request error rates. Small samples are preliminary; request-level confidence intervals assume independent observations, which tool loops and clustered runs may violate. No results have been fabricated.</p>${matrix}${rows.length ? rows.join("") : "<p>No live benchmark results published yet. Provider profiles are configuration, not evidence of support.</p>"}</html>\n`,
	);
	await writeFile(
		join(out, "summary.json"),
		`${JSON.stringify(
			data.map(({ run }) => ({
				runId: run.runId,
				target: run.target,
				metrics: metrics(run),
			})),
			null,
			2,
		)}\n`,
	);
	// Keep evidence URLs local and portable on GitHub Pages.
	for (const { file } of data) {
		const dest = join(out, "results", relative(root, file));
		await mkdir(join(dest, ".."), { recursive: true });
		await writeFile(dest, await readFile(file));
	}
	let html = await readFile(join(out, "index.html"), "utf8");
	html = html.replaceAll('href="../results/', 'href="results/');
	await writeFile(join(out, "index.html"), html);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
	await report();
