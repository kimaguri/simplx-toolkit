import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProdProfile, createTestProfile } from "./profiles/index.js";
import { createSimplxMcpServer } from "./server.js";

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const connection = {
    baseUrl: requiredEnv("SIMPLX_PLATFORM_URL"),
    tenantSlug: requiredEnv("SIMPLX_TENANT_SLUG"),
    bearerToken: requiredEnv("SIMPLX_BEARER_TOKEN"),
  };

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
