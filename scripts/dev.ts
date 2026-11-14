// `npm run dev`: starts the API server and Vite together. If the server cannot start (or
// has no .env), the app still runs and every integration simply shows as off.
import { spawn } from "node:child_process";

const bin = (name: string) => `node_modules/.bin/${name}${process.platform === "win32" ? ".cmd" : ""}`;
const run = (label: string, cmd: string, args: string[]) => {
  const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => {
    if (label === "vite") process.exit(code ?? 0);
    else console.warn(`[dev] the API server stopped (code ${code}); the app keeps running with integrations off.`);
  });
  return child;
};

const server = run("server", bin("tsx"), ["watch", "--clear-screen=false", "server/index.ts"]);
const vite = run("vite", bin("vite"), process.argv.slice(2));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.kill();
    vite.kill();
  });
}
