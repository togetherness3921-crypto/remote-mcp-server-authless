import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleCalendarTools } from "./google-calendar-tools";
// Hardcoded Supabase credentials
const SUPABASE_URL = "https://cvzgxnspmmxxxwnxiydk.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2emd4bnNwbW14eHh3bnhpeWRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njg3NzM1OCwiZXhwIjoyMDcyNDUzMzU4fQ.ZDl4Y3OQOeEeZ_QajGB6iRr0Xk3_Z7TMlI92yFmerzI";
const GRAPH_DOC_ID = "main"; // The single document ID for our graph

async function getGraphDocument() {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/graph_documents?id=eq.${GRAPH_DOC_ID}`, {
        method: 'GET',
        headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Accept': 'application/vnd.pgrst.object+json' // Get a single object, not an array
        }
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch graph document: ${response.status} ${errorText}`);
    }
    return await response.json();
}

async function updateGraphDocument(data: any) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/graph_documents?id=eq.${GRAPH_DOC_ID}`, {
        method: 'PATCH',
        headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify({ data })
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update graph document: ${response.status} ${errorText}`);
    }
    return await response.json();
}

export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "My MCP Server",
        version: "1.0.0",
    });
    private googleTools: GoogleCalendarTools;
    constructor(state?: any, env?: any) {
        super(state, env); 
        this.googleTools = new GoogleCalendarTools();
    }
    async init() {
        // Register Google Calendar tools
        this.googleTools.registerTools(this.server, this.env);
        
        // --- NEW GRAPH MANAGEMENT TOOLS (JSONB) ---

        // Get Current Graph State
        this.server.tool(
            "get_graph_state",
            {},
            async () => {
                try {
                    const doc = await getGraphDocument();
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(doc.data, null, 2)
                        }]
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error getting graph state: ${error.message}`
                        }]
                    };
                }
            }
        );
    }
}
export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        if (url.pathname === "/sse" || url.pathname === "/sse/message") {
            return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
        }
        if (url.pathname === "/mcp") {
            return MyMCP.serve("/mcp").fetch(request, env, ctx);
        }
        return new Response("Not found", { status: 404 });
    },
};
