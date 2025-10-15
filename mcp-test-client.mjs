import { Client } from '@modelcontextprotocol/sdk/dist/cjs/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/dist/cjs/client/sse.js';

const MCP_SERVER_BASE = 'https://remote-mcp-server-authless.harveymushman394.workers.dev';

async function run() {
    const client = new SseClient({
        url: `${MCP_SERVER_BASE}/sse`,
        messageUrl: `${MCP_SERVER_BASE}/sse/message`,
    });

    try {
        console.log('Connecting to MCP server...');
        await client.connect();
        console.log('Connected. Session established.');

        console.log('\n-- tools/list --');
        const tools = await client.listTools();
        console.log(JSON.stringify(tools, null, 2));

        console.log('\n-- get_or_create_default_graph_version --');
        const defaultVersion = await client.callTool('get_or_create_default_graph_version', {});
        console.log(JSON.stringify(defaultVersion, null, 2));
        const baselineVersionId = defaultVersion?.content?.[0]?.text
            ? JSON.parse(defaultVersion.content[0].text).default_graph_document_version_id
            : undefined;
        console.log('Baseline version id:', baselineVersionId);

        console.log('\n-- patch_graph_document --');
        const patchPayload = {
            patches: JSON.stringify([
                {
                    op: 'add',
                    path: '/nodes/mcp_test_node',
                    value: {
                        label: 'MCP Test Node',
                        type: 'ObjectiveNode',
                        status: 'not-started',
                        parents: ['main'],
                    },
                },
            ]),
        };

        const patchResult = await client.callTool('patch_graph_document', patchPayload);
        console.log(JSON.stringify(patchResult, null, 2));
        const patchResponse = patchResult?.content?.[0]?.text ? JSON.parse(patchResult.content[0].text) : undefined;
        const newVersionId = patchResponse?.graph_document_version_id;
        console.log('New version id from patch:', newVersionId);

        console.log('\n-- set_graph_document_to_version (baseline) --');
        if (baselineVersionId) {
            const revertResult = await client.callTool('set_graph_document_to_version', { version_id: baselineVersionId });
            console.log(JSON.stringify(revertResult, null, 2));
        } else {
            console.log('Skipping revert test: baseline version id not available.');
        }

        console.log('\n-- get_graph_document_version (new version) --');
        if (newVersionId) {
            const getResult = await client.callTool('get_graph_document_version', { version_id: newVersionId });
            console.log(JSON.stringify(getResult, null, 2));
        } else {
            console.log('Skipping get version test: new version id not available.');
        }
    } catch (error) {
        console.error('Error during MCP client test:', error);
    } finally {
        await client.close();
        console.log('Disconnected from MCP server.');
    }
}

run();

