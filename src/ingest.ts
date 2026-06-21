import { createReadStream } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse";
import { openDb, initSchema, UPSERT_QUERY_SQL } from "./db.ts";
import { normalize } from "./normalize.ts";

const CSV_PATH =
  process.env.CSV_PATH ??
  join(import.meta.dirname, "..", "data", "amazon_products.csv");
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY ?? 1);

async function main() {
  if (!Number.isInteger(SAMPLE_EVERY) || SAMPLE_EVERY < 1) {
    throw new Error(`SAMPLE_EVERY must be a positive integer, got ${SAMPLE_EVERY}`);
  }
  console.log(`Ingesting ${CSV_PATH}`);
  console.log(`Keeping rows with reviews > 0, sampling 1 in every ${SAMPLE_EVERY}.`);

  const db = openDb();
  initSchema(db);
  db.exec("DELETE FROM queries;");

  const upsert = db.prepare(UPSERT_QUERY_SQL);

  const parser = createReadStream(CSV_PATH).pipe(
    parse({
      columns: true,
      relax_quotes: true,
      relax_column_count: true,
      skip_records_with_error: true,
    })
  );

  let seen = 0;
  let qualifying = 0;
  let kept = 0;

  db.exec("BEGIN");
  for await (const row of parser) {
    seen++;
    const reviews = Number(row.reviews);
    const title: string = row.title ?? "";
    if (!(reviews > 0) || title.trim() === "") continue;

    qualifying++;
    if (qualifying % SAMPLE_EVERY !== 0) continue;

    const query = normalize(title);
    if (query === "") continue;

    upsert.run({ query, display: title, count: reviews });
    kept++;

    if (kept % 50_000 === 0) {
      db.exec("COMMIT");
      db.exec("BEGIN");
      console.log(`  ...read ${seen.toLocaleString()}, kept ${kept.toLocaleString()}`);
    }
  }
  db.exec("COMMIT");

  const unique = db.prepare("SELECT COUNT(*) AS n FROM queries").get() as { n: number };
  const range = db
    .prepare("SELECT MIN(count) AS lo, MAX(count) AS hi FROM queries")
    .get() as { lo: number; hi: number };

  console.log("\nDone.");
  console.log(`  rows read:            ${seen.toLocaleString()}`);
  console.log(`  qualifying (rev>0):   ${qualifying.toLocaleString()}`);
  console.log(`  kept after sampling:  ${kept.toLocaleString()}`);
  console.log(`  unique queries in DB: ${unique.n.toLocaleString()}`);
  console.log(`  count range:          ${range.lo} .. ${range.hi}`);
  if (unique.n < 100_000) {
    console.warn(`  WARNING: below the 100k minimum — lower SAMPLE_EVERY and re-run.`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
