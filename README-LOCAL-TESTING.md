# Local Worker Testing Guide

This setup allows you to run the actual `index.ts` worker locally and test it with real HTTP requests.

## Quick Start

### 1. Install dependencies (if needed)
```bash
npm install -D tsx
```

### 2. Start the local worker
```bash
node run-worker-local.mjs
```

This will:
- Compile the actual `index.ts` TypeScript code
- Start a local HTTP server on `http://localhost:8787`
- Run the real worker code (not a copy)

### 3. Test it (in a separate terminal)
```bash
node test-local-worker.mjs
```

This sends the exact same MCP request the frontend sends.

## How It Works

### `run-worker-local.mjs`
- **Imports** the actual `src/index.ts` file (not a copy!)
- Compiles TypeScript on-the-fly using `tsx`
- Creates an HTTP server that mimics Cloudflare Workers environment
- Calls the real `fetch` handler from index.ts
- Runs on `http://localhost:8787`

### `test-local-worker.mjs`
- Sends real HTTP POST requests
- Uses the exact MCP protocol format
- Can be configured to test local OR cloud worker
- Shows full request/response details

## Switching Between Local and Cloud

In `test-local-worker.mjs`, change this line:

```javascript
const USE_LOCAL = true;  // Test local worker
const USE_LOCAL = false; // Test cloud worker (after deployment)
```

## Frontend Configuration

To point your frontend to the local worker during development:

1. Find where the MCP endpoint is configured (likely in environment variables or a config file)
2. Change from:
   ```javascript
   const MCP_ENDPOINT = 'https://your-worker.workers.dev/mcp'
   ```
   To:
   ```javascript
   const MCP_ENDPOINT = 'http://localhost:8787/mcp'
   ```

## What This Proves

✓ The actual worker code runs correctly locally  
✓ The HTTP interface works the same as cloud  
✓ The same code can be deployed to cloud  
✓ You can test changes before deploying  

## Deployment Flow

1. **Test locally**: Run worker locally, verify it works
2. **Commit**: Push changes to git
3. **Deploy**: CI pipeline deploys to Cloudflare
4. **Verify**: Use `test-local-worker.mjs` with `USE_LOCAL = false` to test cloud version

## Troubleshooting

### Worker won't start
- Make sure `tsx` is installed: `npm install -D tsx`
- Check for syntax errors in `index.ts`

### Test gets connection error
- Make sure the local worker is running first
- Check that port 8787 is not in use

### Different results local vs cloud
- Check environment variables are the same
- Verify the deployed code matches your local changes

