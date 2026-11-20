#!/usr/bin/env node
// Studio MCP server, stdio only (no network listener). stdout carries the MCP protocol, so
// nothing else may be printed there; problems go to stderr and the log file.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError } from "./config.ts";
import { createStudioMcp } from "./server.ts";

try {
  const mcp = createStudioMcp();
  await mcp.server.connect(new StdioServerTransport());
} catch (error) {
  const message = error instanceof ConfigError ? error.message : "Studio MCP başlatılamadı.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
