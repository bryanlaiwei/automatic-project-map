// Starts the local helper from the command line.
// A successful serve command stays running; every other result exits with its status code.

import { runCli } from "./cli.js";

void runCli(process.argv.slice(2), process.env, {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
}).then(
  (result) => {
    if (process.argv[2] === "serve" && result.exitCode === 0) {
      return;
    }
    process.exit(result.exitCode);
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : "Collector failed.";
    console.error(message);
    process.exit(1);
  },
);
