/**
 * Test Client - Sends real HTTP requests to the local worker
 * This is the EXACT same request the frontend sends
 */

import http from 'http';

// Configuration - switch between local and cloud
const USE_LOCAL = true;

const ENDPOINTS = {
    local: 'http://localhost:8787/mcp',
    cloud: 'https://remote-mcp-server-authless.your-subdomain.workers.dev/mcp'
};

const ENDPOINT = USE_LOCAL ? ENDPOINTS.local : ENDPOINTS.cloud;

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  TEST CLIENT - Sending Real HTTP Request                  ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('Target:', USE_LOCAL ? 'LOCAL WORKER' : 'CLOUD WORKER');
console.log('URL:', ENDPOINT);
console.log('');

// This is the EXACT MCP request the frontend sends
const mcpRequest = {
    jsonrpc: '2.0',
    id: 'test-' + Date.now(),
    method: 'tools/call',
    params: {
        name: 'get_messages_for_period',
        arguments: {
            conversation_id: 'f44410bf-85db-4f94-a988-ee13ebc3b72c',
            message_id: '06f8c6a6-4a87-44a4-ac5b-031790715da2',
            period_start: '2025-10-15T00:00:00.000Z',
            period_end: '2025-10-16T00:00:00.000Z'
        }
    }
};

console.log('Request:');
console.log(JSON.stringify(mcpRequest, null, 2));
console.log('\nSending...\n');

const requestBody = JSON.stringify(mcpRequest);
const url = new URL(ENDPOINT);

const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
    }
};

const req = http.request(options, (res) => {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  RESPONSE FROM WORKER                                      ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('Status:', res.statusCode);
    console.log('Headers:');
    Object.entries(res.headers).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
    });
    console.log('');

    let responseData = '';

    res.on('data', (chunk) => {
        responseData += chunk.toString();
    });

    res.on('end', () => {
        console.log('Response Body:');
        try {
            const parsed = JSON.parse(responseData);
            console.log(JSON.stringify(parsed, null, 2));

            // Parse the tool result
            if (parsed.result && parsed.result.content && parsed.result.content[0]) {
                const toolResponse = JSON.parse(parsed.result.content[0].text);

                console.log('\n╔════════════════════════════════════════════════════════════╗');
                console.log('║  TOOL RESULT                                               ║');
                console.log('╚════════════════════════════════════════════════════════════╝\n');

                console.log('Tool:', toolResponse.tool);
                console.log('Success:', toolResponse.success);

                if (toolResponse.success && toolResponse.data) {
                    const messages = toolResponse.data.messages || [];
                    console.log('Messages found:', messages.length);

                    if (messages.length > 0) {
                        console.log('\n✓ SUCCESS! Worker returned messages:\n');
                        messages.forEach((msg, i) => {
                            console.log(`  ${i + 1}. [${msg.role}] ${msg.created_at}`);
                            if (msg.content) {
                                const preview = msg.content.substring(0, 60);
                                console.log(`     ${preview}${msg.content.length > 60 ? '...' : ''}`);
                            }
                        });
                    } else {
                        console.log('\n⚠️  Worker returned 0 messages');
                        console.log('   Expected 5 messages for this date range');
                    }
                } else if (toolResponse.error) {
                    console.log('Error:', toolResponse.error);
                    console.log('\n✗ Worker returned an error');
                }
            }
        } catch (e) {
            console.log(responseData);
            console.error('\nFailed to parse as JSON');
        }

        console.log('\n✓ Test complete\n');
        process.exit(0);
    });
});

req.on('error', (err) => {
    console.error('✗ Request failed:', err.message);

    if (USE_LOCAL) {
        console.error('\nMake sure the local worker is running:');
        console.error('  node run-worker-local.mjs');
    }

    process.exit(1);
});

req.write(requestBody);
req.end();

