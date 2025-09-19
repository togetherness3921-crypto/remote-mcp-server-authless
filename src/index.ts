import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleCalendarTools } from "./google-calendar-tools";
// Hardcoded Supabase credentials
const SUPABASE_URL = "https://cvzgxnspmmxxxwnxiydk.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2emd4bnNwbW14eHh3bnhpeWRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njg3NzM1OCwiZXhwIjoyMDcyNDUzMzU4fQ.ZDl4Y3OQOeEeZ_QajGB6iRr0Xk3_Z7TMlI92yFmerzI";
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
        // GRAPH MANAGEMENT TOOLS FOR SUPABASE
        // Update Node Status
        this.server.tool(
            "update_node",
            {
                node_id: z.string(),
                label: z.string().optional(),
                status: z.enum(["not-started", "in-progress", "completed", "blocked"]).optional(),
                expanded: z.boolean().optional(),
                position_x: z.number().optional(),
                position_y: z.number().optional(),
            },
            async ({ node_id, label, status, expanded, position_x, position_y }) => {
                try {
                    const updates: any = {};
                    if (label !== undefined) updates.label = label;
                    if (status !== undefined) updates.status = status;
                    if (expanded !== undefined) updates.expanded = expanded;
                    if (position_x !== undefined) updates.position_x = position_x;
                    if (position_y !== undefined) updates.position_y = position_y;
                    
                    const response = await fetch(`${SUPABASE_URL}/rest/v1/nodes?id=eq.${node_id}`, {
                        method: "PATCH",
                        headers: {
                            'apikey': SUPABASE_SERVICE_KEY,
                            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=representation'  // Request the updated data back
                        },
                        body: JSON.stringify(updates)
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`HTTP ${response.status}: ${errorText}`);
                    }
                    
                    // Check if there's content to parse
                    const contentType = response.headers.get('content-type');
                    let result = null;
                    if (contentType && contentType.includes('application/json')) {
                        const text = await response.text();
                        if (text) {
                            result = JSON.parse(text);
                        }
                    }
                    
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                node_id: node_id,
                                updates: updates,
                                result: result
                            })
                        }]
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: false,
                                error: error.message
                            })
                        }]
                    };
                }
            }
        );
        // Add Sub-Objective to Node
        this.server.tool(
            "add_sub_objective",
            {
                node_id: z.string(),
                label: z.string(),
                order_index: z.number().optional(),
            },
            async ({ node_id, label, order_index }) => {
                try {
                    const newSubObjective = {
                        id: `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        node_id: node_id,
                        label: label,
                        status: "not-started",
                        order_index: order_index || 0
                    };
                    
                    const response = await fetch(`${SUPABASE_URL}/rest/v1/sub_objectives`, {
                        method: "POST",
                        headers: {
                            'apikey': SUPABASE_SERVICE_KEY,
                            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=representation'  // Request the created data back
                        },
                        body: JSON.stringify(newSubObjective)
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`HTTP ${response.status}: ${errorText}`);
                    }
                    
                    // Check if there's content to parse
                    const contentType = response.headers.get('content-type');
                    let result = null;
                    if (contentType && contentType.includes('application/json')) {
                        const text = await response.text();
                        if (text) {
                            result = JSON.parse(text);
                        }
                    }
                    
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                sub_objective: newSubObjective,
                                result: result
                            })
                        }]
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: false,
                                error: error.message
                            })
                        }]
                    };
                }
            }
        );
        // Update Sub-Objective Status
        this.server.tool(
            "update_sub_objective",
            {
                sub_objective_id: z.string(),
                label: z.string().optional(),
                status: z.enum(["not-started", "in-progress", "completed", "blocked"]).optional(),
            },
            async ({ sub_objective_id, label, status }) => {
                try {
                    const updates: any = {};
                    if (label !== undefined) updates.label = label;
                    if (status !== undefined) updates.status = status;
                    
                    const response = await fetch(`${SUPABASE_URL}/rest/v1/sub_objectives?id=eq.${sub_objective_id}`, {
                        method: "PATCH",
                        headers: {
                            'apikey': SUPABASE_SERVICE_KEY,
                            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=representation'  // Request the updated data back
                        },
                        body: JSON.stringify(updates)
                    });
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`HTTP ${response.status}: ${errorText}`);
                    }
                    
                    // Check if there's content to parse
                    const contentType = response.headers.get('content-type');
                    let result = null;
                    if (contentType && contentType.includes('application/json')) {
                        const text = await response.text();
                        if (text) {
                            result = JSON.parse(text);
                        }
                    }
                    
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                sub_objective_id: sub_objective_id,
                                updates: updates,
                                result: result
                            })
                        }]
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: false,
                                error: error.message
                            })
                        }]
                    };
                }
            }
        );
        // Get Current Graph State
        this.server.tool(
            "get_graph_state",
            {
                include_completed: z.boolean().optional().default(false),
            },
            async ({ include_completed }) => {
                try {
                    // Get nodes
                    let nodesQuery = `${SUPABASE_URL}/rest/v1/nodes?select=*`;
                    if (!include_completed) {
                        nodesQuery += `&status=neq.completed`;
                    }
                    
                    const nodesResponse = await fetch(nodesQuery, {
                        headers: {
                            'apikey': SUPABASE_SERVICE_KEY,
                            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                        }
                    });
                    const nodes = await nodesResponse.json();
                    
                    // Get sub-objectives
                    let subObjQuery = `${SUPABASE_URL}/rest/v1/sub_objectives?select=*&order=order_index`;
                    if (!include_completed) {
                        subObjQuery += `&status=neq.completed`;
                    }
                    
                    const subObjResponse = await fetch(subObjQuery, {
                        headers: {
                            'apikey': SUPABASE_SERVICE_KEY,
                            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                        }
                    });
                    const subObjectives = await subObjResponse.json();
                    
                    // Get edges
                    const edgesResponse = await fetch(`${SUPABASE_URL}/rest/v1/edges?select=*`, {
                        headers: {
                            'apikey': SUPABASE_SERVICE_KEY,
                            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                        }
                    });
                    const edges = await edgesResponse.json();
                    
                    // Build summary
                    const activeNodes = nodes.filter(n => n.status === 'in-progress');
                    const blockedNodes = nodes.filter(n => n.status === 'blocked');
                    
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                summary: {
                                    total_nodes: nodes.length,
                                    active: activeNodes.map(n => n.label),
                                    blocked: blockedNodes.map(n => n.label),
                                    connections: edges.length
                                },
                                nodes: nodes,
                                sub_objectives_by_node: subObjectives.reduce((acc, sub) => {
                                    if (!acc[sub.node_id]) acc[sub.node_id] = [];
                                    acc[sub.node_id].push(sub);
                                    return acc;
                                }, {})
                            }, null, 2)
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
