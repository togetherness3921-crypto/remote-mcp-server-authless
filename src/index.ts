import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleCalendarTools } from "./google-calendar-tools";

export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "My MCP Server",
        version: "1.0.0",
    });

    private env: any;
    private googleTools: GoogleCalendarTools;

    constructor() {
        super();
        this.googleTools = new GoogleCalendarTools();
    }

    async init(env: any) {
        this.env = env;

        // Register Google Calendar tools
        this.googleTools.registerTools(this.server, env);

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
                    const supabaseUrl = this.env.SUPABASE_URL;
                    const supabaseKey = this.env.SUPABASE_SERVICE_KEY;
                    
                    const updates: any = {};
                    if (label !== undefined) updates.label = label;
                    if (status !== undefined) updates.status = status;
                    if (expanded !== undefined) updates.expanded = expanded;
                    if (position_x !== undefined) updates.position_x = position_x;
                    if (position_y !== undefined) updates.position_y = position_y;
                    
                    const response = await fetch(`${supabaseUrl}/rest/v1/nodes?id=eq.${node_id}`, {
                        method: "PATCH",
                        headers: {
                            'apikey': supabaseKey,
                            'Authorization': `Bearer ${supabaseKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(updates)
                    });
                    
                    const result = await response.json();
                    return {
                        content: [{
                            type: "text",
                            text: `Updated node ${node_id}: ${JSON.stringify(updates)}`
                        }]
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error updating node: ${error.message}`
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
                    const supabaseUrl = this.env.SUPABASE_URL;
                    const supabaseKey = this.env.SUPABASE_SERVICE_KEY;
                    
                    const newSubObjective = {
                        id: `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        node_id: node_id,
                        label: label,
                        status: "not-started",
                        order_index: order_index || 0
                    };
                    
                    const response = await fetch(`${supabaseUrl}/rest/v1/sub_objectives`, {
                        method: "POST",
                        headers: {
                            'apikey': supabaseKey,
                            'Authorization': `Bearer ${supabaseKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(newSubObjective)
                    });
                    
                    const result = await response.json();
                    return {
                        content: [{
                            type: "text",
                            text: `Added sub-objective: ${label} to node ${node_id}`
                        }]
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error adding sub-objective: ${error.message}`
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
                    const supabaseUrl = this.env.SUPABASE_URL;
                    const supabaseKey = this.env.SUPABASE_SERVICE_KEY;
                    
                    const updates: any = {};
                    if (label !== undefined) updates.label = label;
                    if (status !== undefined) updates.status = status;
                    
                    const response = await fetch(`${supabaseUrl}/rest/v1/sub_objectives?id=eq.${sub_objective_id}`, {
                        method: "PATCH",
                        headers: {
                            'apikey': supabaseKey,
                            'Authorization': `Bearer ${supabaseKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(updates)
                    });
                    
                    const result = await response.json();
                    return {
                        content: [{
                            type: "text",
                            text: `Updated sub-objective ${sub_objective_id}: ${JSON.stringify(updates)}`
                        }]
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error updating sub-objective: ${error.message}`
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
                    const supabaseUrl = this.env.SUPABASE_URL;
                    const supabaseKey = this.env.SUPABASE_SERVICE_KEY;
                    
                    // Get nodes
                    let nodesQuery = `${supabaseUrl}/rest/v1/nodes?select=*`;
                    if (!include_completed) {
                        nodesQuery += `&status=neq.completed`;
                    }
                    
                    const nodesResponse = await fetch(nodesQuery, {
                        headers: {
                            'apikey': supabaseKey,
                            'Authorization': `Bearer ${supabaseKey}`,
                        }
                    });
                    const nodes = await nodesResponse.json();
                    
                    // Get sub-objectives
                    let subObjQuery = `${supabaseUrl}/rest/v1/sub_objectives?select=*&order=order_index`;
                    if (!include_completed) {
                        subObjQuery += `&status=neq.completed`;
                    }
                    
                    const subObjResponse = await fetch(subObjQuery, {
                        headers: {
                            'apikey': supabaseKey,
                            'Authorization': `Bearer ${supabaseKey}`,
                        }
                    });
                    const subObjectives = await subObjResponse.json();
                    
                    // Get edges
                    const edgesResponse = await fetch(`${supabaseUrl}/rest/v1/edges?select=*`, {
                        headers: {
                            'apikey': supabaseKey,
                            'Authorization': `Bearer ${supabaseKey}`,
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
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const mcp = new MyMCP();
        
        if (url.pathname === "/sse" || url.pathname === "/sse/message") {
            await mcp.init(env);
            return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
        }
        if (url.pathname === "/mcp") {
            await mcp.init(env);
            return MyMCP.serve("/mcp").fetch(request, env, ctx);
        }
        return new Response("Not found", { status: 404 });
    },
};
