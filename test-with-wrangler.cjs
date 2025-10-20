/**
 * Test the actual worker using wrangler dev (local Cloudflare Workers environment)
 * This starts the real worker and sends an HTTP request to it
 */

const { spawn } = require('child_process');
const http = require('http');

const TEST_PARAMS = {
  conversation_id: 'f44410bf-85db-4f94-a988-ee13ebc3b72c',
  message_id: '06f8c6a6-4a87-44a4-ac5b-031790715da2',
  period_start: '2025-10-15T00:00:00.000Z',
  period_end: '2025-10-16T00:00:00.000Z'
};

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  TESTING ACTUAL WORKER WITH WRANGLER DEV                  ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('This will:');
console.log('  1. Start worker with wrangler dev (local Cloudflare environment)');
console.log('  2. Wait for worker to be ready');
console.log('  3. Send real MCP tool call via HTTP');
console.log('  4. Show the actual response\n');

console.log('[1/3] Starting wrangler dev...\n');

const wranglerProcess = spawn('npx', ['wrangler', 'dev', '--local', '--port', '8788'], {
  cwd: __dirname,
  stdio: 'pipe',
  shell: true
});

let workerReady = false;
let workerOutput = '';

wranglerProcess.stdout.on('data', (data) => {
  const text = data.toString();
  workerOutput += text;
  process.stdout.write(text);
  
  // Check if worker is ready
  if (text.includes('Ready on') || text.includes('listening on') || text.includes('http://')) {
    workerReady = true;
    console.log('\n✓ Worker is ready!\n');
    setTimeout(sendTestRequest, 2000);
  }
});

wranglerProcess.stderr.on('data', (data) => {
  const text = data.toString();
  process.stderr.write(text);
});

wranglerProcess.on('error', (err) => {
  console.error('Failed to start wrangler:', err);
  process.exit(1);
});

// Timeout if worker doesn't start in 30 seconds
setTimeout(() => {
  if (!workerReady) {
    console.error('\n✗ Worker did not start within 30 seconds');
    console.log('\nWorker output so far:');
    console.log(workerOutput);
    wranglerProcess.kill();
    process.exit(1);
  }
}, 30000);

async function sendTestRequest() {
  console.log('[2/3] Sending MCP tool call to worker...\n');
  
  // MCP tool call request format
  const mcpRequest = {
    jsonrpc: '2.0',
    id: 'test-request-1',
    method: 'tools/call',
    params: {
      name: 'get_messages_for_period',
      arguments: TEST_PARAMS
    }
  };
  
  console.log('Request:');
  console.log(JSON.stringify(mcpRequest, null, 2));
  console.log('');
  
  const postData = JSON.stringify(mcpRequest);
  
  const options = {
    hostname: 'localhost',
    port: 8788,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  
  const req = http.request(options, (res) => {
    console.log('[3/3] Response from worker:\n');
    console.log('Status:', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers, null, 2));
    console.log('');
    
    let responseData = '';
    
    res.on('data', (chunk) => {
      responseData += chunk.toString();
    });
    
    res.on('end', () => {
      console.log('Body:');
      try {
        const parsed = JSON.parse(responseData);
        console.log(JSON.stringify(parsed, null, 2));
        
        // Extract the actual result
        if (parsed.result && parsed.result.content && parsed.result.content[0]) {
          console.log('\n╔════════════════════════════════════════════════════════════╗');
          console.log('║  TOOL RESPONSE                                             ║');
          console.log('╚════════════════════════════════════════════════════════════╝\n');
          
          const toolResult = JSON.parse(parsed.result.content[0].text);
          console.log('Success:', toolResult.success);
          
          if (toolResult.success) {
            const messages = toolResult.data?.messages || [];
            console.log('Messages found:', messages.length);
            
            if (messages.length > 0) {
              console.log('\n✓ WORKER RETURNED MESSAGES!\n');
              messages.forEach((msg, i) => {
                console.log(`  ${i + 1}. ${msg.id} - ${msg.role} - ${msg.created_at}`);
              });
            } else {
              console.log('\n⚠️  Worker returned 0 messages');
              console.log('   This means the deployed code still has the old column names');
            }
          } else {
            console.log('Error:', toolResult.error);
          }
        }
      } catch (e) {
        console.log(responseData);
        console.error('\nFailed to parse response as JSON:', e.message);
      }
      
      console.log('\n\n✓ Test complete! Shutting down worker...\n');
      wranglerProcess.kill();
      process.exit(0);
    });
  });
  
  req.on('error', (err) => {
    console.error('Request failed:', err);
    wranglerProcess.kill();
    process.exit(1);
  });
  
  req.write(postData);
  req.end();
}

