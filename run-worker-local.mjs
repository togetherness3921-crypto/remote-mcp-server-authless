/**
 * Local Worker Host - Runs the ACTUAL index.ts worker locally
 * This creates a proper Cloudflare-like environment and imports the real worker
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  LOCAL WORKER HOST - Running Actual index.ts              ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const PORT = 8787;

// Environment variables (same as cloud deployment)
const env = {
    SUPABASE_URL: 'https://cvzgxnspmmxxxwnxiydk.supabase.co',
    SUPABASE_SERVICE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2emd4bnNwbW14eHh3bnhpeWRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njg3NzM1OCwiZXhwIjoyMDcyNDUzMzU4fQ.ZDl4Y3OQOeEeZ_QajGB6iRr0Xk3_Z7TMlI92yFmerzI',
    GROQ_API_KEY: process.env.GROQ_API_KEY || ''
};

console.log('[1/3] Compiling TypeScript worker...\n');

// Use tsx to compile and import the actual worker
import('tsx/esm').then(async (tsx) => {
    // This will compile and load the ACTUAL index.ts file
    const workerModule = await import('./src/index.ts');
    const worker = workerModule.default;

    if (!worker || !worker.fetch) {
        throw new Error('Worker does not export a default object with fetch handler');
    }

    console.log('✓ Worker compiled and loaded\n');
    console.log('[2/3] Starting HTTP server...\n');

    const server = createServer(async (req, res) => {
        try {
            // Build full URL
            const protocol = 'http';
            const host = req.headers.host || `localhost:${PORT}`;
            const url = `${protocol}://${host}${req.url}`;

            // Collect request body
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            const body = Buffer.concat(chunks);

            // Create Cloudflare-style Request object
            const request = new Request(url, {
                method: req.method,
                headers: req.headers,
                body: body.length > 0 ? body : undefined,
            });

            console.log(`[REQUEST] ${req.method} ${req.url}`);

            // Create mock ExecutionContext
            const ctx = {
                waitUntil: (promise) => promise,
                passThroughOnException: () => { },
            };

            // Call the ACTUAL worker fetch handler
            const response = await worker.fetch(request, env, ctx);

            // Send response back
            res.statusCode = response.status;

            // Copy headers
            response.headers.forEach((value, key) => {
                res.setHeader(key, value);
            });

            // Send body
            const responseBody = await response.text();
            console.log(`[RESPONSE] ${response.status} ${responseBody.length} bytes\n`);
            res.end(responseBody);

        } catch (error) {
            console.error('[ERROR]', error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
        }
    });

    server.listen(PORT, () => {
        console.log('✓ Server started\n');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║  WORKER IS RUNNING                                         ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');
        console.log(`Local worker URL: http://localhost:${PORT}`);
        console.log(`MCP endpoint:     http://localhost:${PORT}/mcp`);
        console.log(`SSE endpoint:     http://localhost:${PORT}/sse`);
        console.log('');
        console.log('The worker is now running with the ACTUAL index.ts code.');
        console.log('You can send HTTP requests to it just like the cloud version.\n');
        console.log('[3/3] Ready for requests...\n');
    });

}).catch(err => {
    console.error('Failed to start worker:', err);
    console.error('\nMake sure tsx is installed:');
    console.error('  npm install -D tsx');
    process.exit(1);
});

