#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildPatientConfig } from './consult-client.js';
import { tools } from './tools.js';

const config = (() => {
    try {
        return buildPatientConfig(process.env);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
})();

const server = new McpServer({
    name: 'ai-nurse',
    version: '0.0.1',
});

for (const tool of tools) {
    server.registerTool(
        tool.name,
        {
            description: tool.description,
            inputSchema: tool.inputSchema,
        },
        async (args: Record<string, unknown>) => {
            try {
                const result = await tool.handler(args, config);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: 'text' as const, text: `Error: ${message}` }],
                    isError: true,
                };
            }
        },
    );
}

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
