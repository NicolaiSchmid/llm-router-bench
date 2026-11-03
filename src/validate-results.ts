import { loadRuns } from "./report.ts";

const runs = await loadRuns(process.argv[2] ?? "results");
for (const { run } of runs) {
	if (Date.parse(run.end) < Date.parse(run.start))
		throw new Error("Run ends before it starts");
	const keys = new Set<string>();
	for (const a of run.attempts) {
		const k = `${a.caseId}:${a.repetition}`;
		if (keys.has(k)) throw new Error("Duplicate attempt");
		keys.add(k);
		if (a.repetition > run.settings.repetitions)
			throw new Error("Invalid repetition");
		if ((a.state === "completed") !== (a.outcome !== null))
			throw new Error("Outcome contradicts execution state");
	}
}
console.log(`Validated ${runs.length} runs`);
