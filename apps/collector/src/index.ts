import { runCli } from "./cli.js";

const token = process.env.APM_ACCESS_TOKEN?.trim() ?? "";

void runCli(process.argv.slice(2), process.env, {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
}).then(
  (result) => {
    process.exit(result.exitCode);
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : "Collector failed.";
    console.error(token === "" ? message : message.split(token).join("[redacted]"));
    process.exit(1);
  },
);
