import express from "express";
import { SCHEMA_VERSION } from "@apm/shared";

const port = Number(process.env.API_PORT ?? 4000);
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, schemaVersion: SCHEMA_VERSION });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`api listening on http://127.0.0.1:${port}`);
});
