import { collectSession } from "./collect.js";

const filePath = process.argv[2];
const trackingStartedAt = process.argv[3];
const agent = process.argv[4];
const selectedRoots = process.argv.slice(5);

if (!filePath || !trackingStartedAt || (agent !== "codex" && agent !== "cursor" && agent !== "claude_code")) {
  console.log("collector ready");
  console.log("usage: npm start -w @apm/collector -- <file> <trackingStartedAt> <codex|cursor|claude_code> <root...>");
} else {
  const result = collectSession({
    agent,
    filePath,
    projectId: "00000000-0000-4000-8000-000000000000",
    trackingStartedAt,
    selectedRoots,
  });
  console.log(JSON.stringify(result, null, 2));
}
