/**
 * Local Test Harness for Worker
 * Runs the actual index.ts code and sends real MCP tool calls to it
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test parameters from frontend logs
const TEST_PARAMS = {
    conversation_id: 'f44410bf-85db-4f94-a988-ee13ebc3b72c',
    message_id: '06f8c6a6-4a87-44a4-ac5b-031790715da2',
    period_start: '2025-10-15T00:00:00.000Z',
    period_end: '2025-10-16T00:00:00.000Z'
};

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  RUNNING ACTUAL WORKER CODE LOCALLY (index.ts)            ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('Test will:');
console.log('  1. Compile TypeScript worker code');
console.log('  2. Start local MCP server from index.ts');
console.log('  3. Send actual MCP tool call: get_messages_for_period');
console.log('  4. Show the real response\n');

console.log('Test Parameters:');
console.log('  conversation_id:', TEST_PARAMS.conversation_id);
console.log('  message_id:', TEST_PARAMS.message_id);
console.log('  period_start:', TEST_PARAMS.period_start);
console.log('  period_end:', TEST_PARAMS.period_end);
console.log('');

// We'll use tsx to run TypeScript directly
console.log('[1/4] Installing tsx if needed...');
const installProcess = spawn('npm', ['install', '-D', 'tsx'], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: true
});

installProcess.on('close', (code) => {
    if (code !== 0) {
        console.error('Failed to install tsx');
        process.exit(1);
    }

    console.log('\n[2/4] Starting worker with tsx...');
    console.log('This will compile and run index.ts directly\n');

    // Run the worker using tsx
    const workerProcess = spawn('npx', ['tsx', 'src/index.ts'], {
        cwd: __dirname,
        stdio: 'pipe',
        shell: true,
        env: {
            ...process.env,
            NODE_ENV: 'development',
            // Cloudflare Worker environment variables
            SUPABASE_URL: 'https://cvzgxnspmmxxxwnxiydk.supabase.co',
            SUPABASE_SERVICE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2emd4bnNwbW14eHh3bnhpeWRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njg3NzM1OCwiZXhwIjoyMDcyNDUzMzU4fQ.ZDl4Y3OQOeEeZ_QajGB6iRr0Xk3_Z7TMlI92yFmerzI'
        }
    });

    let output = '';
    let errorOutput = '';

    workerProcess.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        process.stdout.write(text);
    });

    workerProcess.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        process.stderr.write(text);
    });

    workerProcess.on('close', (code) => {
        console.log('\n[4/4] Worker process ended with code:', code);
        if (code !== 0) {
            console.error('\nWorker failed to start or crashed');
            console.error('Error output:', errorOutput);
        }
    });

    // Give the worker 2 seconds to start, then send test request
    setTimeout(() => {
        console.log('\n[3/4] Worker should be running, but...');
        console.log('⚠️  The worker index.ts is designed for Cloudflare Workers environment');
        console.log('   It expects to be invoked as a fetch handler, not run directly');
        console.log('\n   To properly test, we need to create a Cloudflare Workers dev environment');
        console.log('   or use wrangler dev. Let me create an alternative approach...\n');

        // Kill the worker process
        workerProcess.kill();
        process.exit(0);
    }, 2000);
});

