// Explicit maintenance command, never part of install/build/test. Downloads only bounded windows.
import { mkdir, writeFile } from "node:fs/promises";
import { loadGeography } from "../server/geography";

const examples = [
  { id: "loch-lomond", label: "Loch Lomond, Scotland", lat: 56.075, lon: -4.63, sizeM: 4000 },
  { id: "sierra-nevada", label: "Sierra Nevada, Spain", lat: 37.123, lon: -3.48, sizeM: 4000 },
];
await mkdir("public/geography", { recursive: true });
const manifest: { id: string; label: string; file: string }[] = [];
for (const example of examples) {
  const result = await loadGeography(example);
  const file = `/geography/${example.id}.json`;
  await writeFile(`public${file}`, JSON.stringify(result));
  manifest.push({ id: example.id, label: example.label, file });
  const elevations = result.elevationM;
  console.log(`${example.label}: ${Math.min(...elevations)}–${Math.max(...elevations)} m; WorldCover classes ${[...new Set(result.landCover)].join(", ")}; retrieved ${result.metadata.retrievedAt}`);
}
await writeFile("public/geography/examples.json", JSON.stringify({ examples: manifest }, null, 2) + "\n");
