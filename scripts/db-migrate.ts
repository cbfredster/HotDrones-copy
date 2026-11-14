// Create / update the Tiger Data schema (server/sql/schema.sql). The server also does this on start.
import { env } from "../server/env";
import { Tiger } from "../server/tiger";

const t = await Tiger.connect(env.tigerUrl);
if (!t) {
  console.error("Set TIGER_DATABASE_URL in .env first (see .env.example).");
  process.exit(1);
}
console.log(t.ready ? `Schema ready. ${t.status().detail}` : `Failed: ${t.lastError}`);
await t.close();
process.exit(t.ready ? 0 : 1);
