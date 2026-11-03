import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { runSchema } from "../src/model.ts";
await writeFile("schemas/run.schema.json", `${JSON.stringify(z.toJSONSchema(runSchema),null,2)}\n`);
