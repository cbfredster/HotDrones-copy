// Proves the sim has not drifted: with every new behaviour switched off (--legacy), the
// experiment must reproduce the frozen 2D version's results byte for byte.
// Usage: npm run experiment:legacy-check   (runs the legacy sweep first, about 2.5 min)
import { readFileSync } from "node:fs";

const fresh = readFileSync("results/legacy/summary.csv", "utf8");
const frozen = readFileSync("BASIC/results/summary.csv", "utf8");
if (fresh === frozen) {
  console.log(`OK: results/legacy/summary.csv is identical to BASIC/results/summary.csv (${frozen.split("\n").length - 1} conditions).`);
} else {
  const a = fresh.split("\n");
  const b = frozen.split("\n");
  const diffs = b.map((line, i) => (line === a[i] ? null : `  line ${i + 1}\n    frozen: ${line}\n    now:    ${a[i]}`)).filter(Boolean);
  console.error(`DRIFT: ${diffs.length} of ${b.length} lines differ from the frozen 2D results.\n${diffs.slice(0, 8).join("\n")}`);
  process.exit(1);
}
