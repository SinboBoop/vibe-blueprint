#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createFoundationMcpServer } from "./mcp-server.js";
import { createLogger } from "./logger.js";
import { safeErrorMessage } from "./security.js";

const log = createLogger({ stream: process.stderr });

async function main(): Promise<void> {
  const server = createFoundationMcpServer();
  await server.connect(new StdioServerTransport());
  log.info("Vibe Blueprint MCP started", { transport: "stdio" });
}

void main().catch((error: unknown) => {
  log.error("Vibe Blueprint MCP failed", { error: safeErrorMessage(error) });
  process.exitCode = 1;
});
