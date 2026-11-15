// `npm run dev`: starts the API server and Vite together. If the server cannot start (or
// has no .env), the app still runs and every integration simply shows as off.
//
// Both are started as `node <their JS entry point>` with no shell. Going through
// node_modules/.bin and a shell broke on Windows: cmd.exe read the "/" in the path as a
// switch, and folder names with spaces (e.g. "OneDrive - Durham University") split apart.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const entry = (pkg: string, bin: string) => join(dirname(require.resolve(`${pkg}/package.json`)), bin);

const run = (label: string, script: string, args: string[]) => {
  const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
  child.on("exit", (code) => {
    if (label === "vite") process.exit(code ?? 0);
    else console.warn(`[dev] the API server stopped (code ${code}); the app keeps running with integrations off.`);
  });
  return child;
};

const server = run("server", entry("tsx", "dist/cli.mjs"), ["watch", "--clear-screen=false", "server/index.ts"]);
const vite = run("vite", entry("vite", "bin/vite.js"), process.argv.slice(2));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.kill();
    vite.kill();
  });
}
