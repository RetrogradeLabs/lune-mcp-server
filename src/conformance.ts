import express from "express";
import { buildHttpApp } from "./transport/streamableHttp.js";

const port = Number(process.env.PORT ?? "8099");
const mcpApp = buildHttpApp({
  credentialProbe: async () => ({
    status: "valid",
    workspaceCredential: false,
  }),
});
const app = express();
app.use((req, _res, next) => {
  req.headers.authorization = "Bearer lune_conformance_local_only";
  next();
});
app.use(mcpApp);
const server = app.listen(port, "127.0.0.1", () => {
  process.stderr.write(
    `Lune MCP conformance server listening on http://127.0.0.1:${port}\n`,
  );
});

function close(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
