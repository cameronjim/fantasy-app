// stdout is the jsonrpc channel; a future dotenv v17 would log to it on import
process.env.DOTENV_CONFIG_QUIET ??= 'true';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { registerAllTools } = await import('./tools.js');

const server = new McpServer({ name: 'nba-iq', version: '1.0.0' });
registerAllTools(server);
await server.connect(new StdioServerTransport());
