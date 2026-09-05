import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConnectionFromEnv } from "./env.js";
import { createProdProfile, createTestProfile } from "./profiles/index.js";
import { createSimplxMcpServer } from "./server.js";

const main = async (): Promise<void> => {
  const connection = readConnectionFromEnv(process.env);

  const profileName = process.env["SIMPLX_MCP_PROFILE"] ?? "prod";
  const profile = profileName === "test" ? createTestProfile(connection) : createProdProfile(connection);

  const server = createSimplxMcpServer({ profile });
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
