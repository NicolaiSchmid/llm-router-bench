import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
/** Resolve through Node's module graph; dependencies can be hoisted or pnpm siblings. */
export async function dependencyVersions(ids: string[]) {
	const require = createRequire(import.meta.url);
	const versions: Record<string, string> = {};
	for (const id of ids) {
		let dir = dirname(require.resolve(id));
		for (;;) {
			try {
				const pkg = JSON.parse(
					await readFile(`${dir}/package.json`, "utf8"),
				) as { name?: string; version?: string };
				if (pkg.name === id && pkg.version) {
					versions[id] = pkg.version;
					break;
				}
			} catch {
				/* The entrypoint can be below the package metadata. */
			}
			const parent = dirname(dir);
			if (parent === dir)
				throw new Error("Could not resolve dependency version");
			dir = parent;
		}
	}
	return versions;
}
