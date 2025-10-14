import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Operation, applyPatch } from "fast-json-patch";
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client
const SUPABASE_URL = "https://cvzgxnspmmxxxwnxiydk.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2emd4bnNwbW14eHh3bnhpeWRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njg3NzM1OCwiZXhwIjoyMDcyNDUzMzU4fQ.ZDl4Y3OQOeEeZ_QajGB6iRr0Xk3_Z7TMlI92yFmerzI";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

type JSONPatch = Operation[];

function stableStringify(value: unknown): string {
    if (value === null) {
        return "null";
    }

    if (typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        const items = value.map((item) => stableStringify(item));
        return `[${items.join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);

    return `{${entries.join(",")}}`;
}

function calculateTruePercentages(nodes: Record<string, Node>): Record<string, Node> {
    const nodesWithTruePercentage = { ...nodes };
    const memo: Record<string, number> = {};

    function getTruePercentage(nodeId: string): number {
        if (memo[nodeId] !== undefined) {
            return memo[nodeId];
        }

        const node = nodesWithTruePercentage[nodeId];
        if (!node) {
            return 0;
        }

        if (!node.parents || node.parents.length === 0) {
            memo[nodeId] = node.percentage_of_parent || 0;
            return memo[nodeId];
        }

        let totalPercentage = 0;
        node.parents.forEach(parentId => {
            const parentPercentage = getTruePercentage(parentId);
            totalPercentage += (node.percentage_of_parent / 100) * parentPercentage;
        });

        memo[nodeId] = totalPercentage;
        return totalPercentage;
    }

    for (const nodeId in nodesWithTruePercentage) {
        nodesWithTruePercentage[nodeId].true_percentage_of_total = getTruePercentage(nodeId);
    }

    return nodesWithTruePercentage;
}

function calculateScores(nodes: Record<string, Node>): object {
    // Placeholder implementation
    // TODO: Replace with actual score calculation logic based on historical data
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let current_daily_score = 0;
    let planned_daily_score = 0;

    for (const nodeId in nodes) {
        const node = nodes[nodeId];
        const scheduledStart = node.scheduled_start ? new Date(node.scheduled_start) : null;

        if (scheduledStart && scheduledStart.getTime() >= today.getTime()) {
            if (node.status === 'completed') {
                current_daily_score += node.true_percentage_of_total || 0;
            } else {
                planned_daily_score += node.true_percentage_of_total || 0;
            }
        }
    }

    return {
        current_daily_score: Math.round(current_daily_score),
        planned_daily_score: Math.round(planned_daily_score + current_daily_score),
        historical_average_score: 68 // Static placeholder
    };
}


// Define the structure of a node in the graph
interface Node {
    type: string;
    label: string;
    status: "not-started" | "in-progress" | "completed" | "blocked";
    parents: string[];
    percentage_of_parent: number;
    createdAt: string;
    scheduled_start?: string;
    true_percentage_of_total?: number;
}

// Define the structure of the entire graph document   
interface GraphDocument {
    nodes: Record<string, Node>;
    viewport: {
        x: number;
        y: number;
        zoom: number;
    };
    historical_progress: Record<string, any>;
}


export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "My MCP Server",
        version: "1.0.0",
    });

    constructor(state?: any, env?: any) {
        super(state, env);
    }

    private async getGraphDocument(): Promise<GraphDocument> {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/graph_documents?id=eq.main&select=data`, {
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch graph document: ${errorText}`);
        }

        const data: { data: GraphDocument }[] = await response.json();
        if (!data || data.length === 0) {
            throw new Error("Graph document not found.");
        }

        return data[0].data;
    }

    private async updateGraphDocument(document: GraphDocument): Promise<void> {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/graph_documents?id=eq.main`, {
            method: "PATCH",
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ data: document })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update graph document: ${errorText}`);
        }
    }

    private normalizeGraphDocument(document: GraphDocument): GraphDocument {
        const normalizedDoc: GraphDocument = JSON.parse(JSON.stringify(document));
        normalizedDoc.nodes = calculateTruePercentages(normalizedDoc.nodes);
        return normalizedDoc;
    }

    private documentsAreEqual(docA: GraphDocument, docB: GraphDocument): boolean {
        return stableStringify(docA) === stableStringify(docB);
    }

    private async createGraphDocumentVersion(document: GraphDocument): Promise<string> {
        const { data, error } = await supabase
            .from('graph_document_versions')
            .insert([{ data: document }])
            .select('id')
            .single();

        if (error) {
            throw new Error(`Failed to create graph document version: ${error.message}`);
        }

        return data.id as string;
    }

    private async getGraphDocumentVersionById(versionId: string): Promise<GraphDocument | null> {
        const { data, error } = await supabase
            .from('graph_document_versions')
            .select('data')
            .eq('id', versionId)
            .maybeSingle();

        if (error) {
            throw new Error(`Failed to fetch graph document version: ${error.message}`);
        }

        if (!data) {
            return null;
        }

        return data.data as GraphDocument;
    }


    async init() {
        // 0. Tool to get instructions
        this.server.tool(
            "get_system_instructions",
            {},
            async () => {
                console.log("Attempting to execute get_system_instructions...");
                try {
                    console.log("Fetching system instructions from Supabase...");
                    const { data, error } = await supabase
                        .from('system_instructions')
                        .select('content')
                        .eq('id', 'main')
                        .single();

                    if (error) {
                        console.error("Error fetching instructions from Supabase:", error);
                        throw new Error(`Supabase error: ${error.message}`);
                    }

                    console.log("Successfully fetched instructions.");
                    return { content: [{ type: "text", text: data.content }] };
                } catch (error: any) {
                    console.error("Caught error in get_system_instructions:", error);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "get_system_instructions",
                                status: "failed",
                                error: error.message,
                                stack: error.stack
                            })
                        }]
                    };
                }
            }
        );

        // New Tool: Update Tool Instructions
        this.server.tool(
            "update_system_instructions",
            {
                new_instructions_content: z.string().describe("The complete new content for the system instructions file."),
            },
            async ({ new_instructions_content }) => {
                console.log("Attempting to execute update_system_instructions...");
                try {
                    console.log("Updating system instructions in Supabase...");
                    const { error } = await supabase
                        .from('system_instructions')
                        .update({ content: new_instructions_content })
                        .eq('id', 'main');

                    if (error) {
                        console.error("Error updating instructions in Supabase:", error);
                        throw new Error(`Supabase error: ${error.message}`);
                    }

                    console.log("Successfully updated instructions.");
                    return { content: [{ type: "text", text: "System instructions updated successfully." }] };
                } catch (error: any) {
                    console.error("Caught error in update_system_instructions:", error);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "update_system_instructions",
                                status: "failed",
                                error: error.message,
                                stack: error.stack
                            })
                        }]
                    };
                }
            }
        );

        // 1. Read Tool: get_todays_context()
        this.server.tool(
            "get_todays_context",
            {},
            async () => {
                console.log("Attempting to execute get_todays_context...");
                try {
                    console.log("Fetching graph document for today's context...");
                    const doc = await this.getGraphDocument();
                    console.log("Successfully fetched graph document.");

                    let allNodes = doc.nodes;
                    const todaysNodes = new Set<string>();
                    const contextNodes = new Set<string>();
                    const today = new Date().toISOString().split('T')[0];
                    console.log(`Filtering for nodes scheduled on or after: ${today}`);

                    for (const nodeId in allNodes) {
                        if (allNodes[nodeId].scheduled_start?.startsWith(today)) {
                            todaysNodes.add(nodeId);
                        }
                    }
                    console.log(`Found ${todaysNodes.size} nodes for today.`);

                    const nodesToProcess = new Set<string>(todaysNodes);

                    nodesToProcess.forEach(nodeId => {
                        contextNodes.add(nodeId);

                        // 1. Include all incomplete parents recursively
                        const findParents = (id: string) => {
                            const node = allNodes[id];
                            if (node && node.parents) {
                                node.parents.forEach(parentId => {
                                    const parentNode = allNodes[parentId];
                                    if (parentNode && parentNode.status !== 'completed') {
                                        if (!contextNodes.has(parentId)) {
                                            contextNodes.add(parentId);
                                            findParents(parentId); // Recurse
                                        }
                                    }
                                });
                            }
                        };
                        findParents(nodeId);

                        // 2. Include immediate children
                        for (const potentialChildId in allNodes) {
                            const potentialChild = allNodes[potentialChildId];
                            if (potentialChild.parents.includes(nodeId)) {
                                contextNodes.add(potentialChildId);
                            }
                        }
                    });

                    const resultGraph: Record<string, Node> = {};
                    contextNodes.forEach(id => {
                        resultGraph[id] = allNodes[id];
                    });

                    const resultGraphWithPercentages = calculateTruePercentages(resultGraph);
                    console.log("Successfully calculated true percentages.");

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                current_date: new Date().toISOString(),
                                score_context: calculateScores(doc.nodes),
                                context: resultGraphWithPercentages
                            }, null, 2)
                        }]
                    };
                } catch (error: any) {
                    console.error("Caught error in get_todays_context:", error);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "get_todays_context",
                                status: "failed",
                                error: error.message,
                                stack: error.stack
                            })
                        }]
                    };
                }
            }
        );

        // 2. Read Tool: get_graph_structure()
        this.server.tool(
            "get_graph_structure",
            {
                start_node_id: z.string().optional().default("main"),
                depth: z.number().optional().default(-1),
            },
            async ({ start_node_id, depth }) => {
                console.log(`Attempting to execute get_graph_structure with start_node: ${start_node_id}, depth: ${depth}`);
                try {
                    console.log("Fetching graph document for structure...");
                    const doc = await this.getGraphDocument();
                    console.log("Successfully fetched graph document.");

                    let allNodes = doc.nodes;
                    const currentDate = new Date().toISOString();
                    const scoreContext = calculateScores(allNodes);

                    if (start_node_id === "main") {
                        allNodes = calculateTruePercentages(allNodes);
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    current_date: currentDate,
                                    score_context: scoreContext,
                                    structure: allNodes
                                })
                            }]
                        };
                    }

                    if (!allNodes[start_node_id]) {
                        throw new Error(`Start node "${start_node_id}" not found.`);
                    }

                    const resultNodes: Record<string, Node> = {};
                    const queue: [string, number][] = [[start_node_id, 0]]; // [nodeId, currentDepth]

                    while (queue.length > 0) {
                        const [currentNodeId, currentDepth] = queue.shift()!;

                        if (resultNodes[currentNodeId]) {
                            continue;
                        }

                        const currentNode = allNodes[currentNodeId];
                        if (currentNode) {
                            resultNodes[currentNodeId] = currentNode;

                            if (depth === -1 || currentDepth < depth) {
                                currentNode.parents.forEach(parentId => {
                                    if (!resultNodes[parentId]) {
                                        queue.push([parentId, currentDepth + 1]);
                                    }
                                });
                            }
                        }
                    }

                    const resultNodesWithPercentages = calculateTruePercentages(resultNodes);
                    console.log("Successfully calculated true percentages for graph structure.");

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                current_date: currentDate,
                                score_context: scoreContext,
                                structure: resultNodesWithPercentages
                            })
                        }]
                    };
                } catch (error: any) {
                    console.error("Caught error in get_graph_structure:", error);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "get_graph_structure",
                                status: "failed",
                                error: error.message,
                                stack: error.stack
                            })
                        }]
                    };
                }
            }
        );

        // 3. Write Tool: patch_graph_document()
        this.server.tool(
            "patch_graph_document",
            {
                patches: z.any(),
            },
            async ({ patches }) => {
                console.log("Attempting to execute patch_graph_document...");
                try {
                    console.log("Fetching graph document for patching...");
                    const currentDoc = await this.getGraphDocument();
                    console.log("Successfully fetched graph document.");

                    const originalDoc = JSON.parse(JSON.stringify(currentDoc));

                    let parsedPatches: JSONPatch;
                    if (typeof patches === "string") {
                        try {
                            parsedPatches = JSON.parse(patches);
                        } catch (e) {
                            throw new Error("Invalid JSON format for patches string.");
                        }
                    } else {
                        parsedPatches = patches as JSONPatch;
                    }

                    if (!Array.isArray(parsedPatches)) {
                        throw new Error("Patch sequence must be an array.");
                    }

                    const workingDoc = JSON.parse(JSON.stringify(currentDoc));
                    const patchedResult = applyPatch(workingDoc, parsedPatches, true, false);
                    const patchedDoc = patchedResult.newDocument;

                    if (!patchedDoc) {
                        throw new Error("Patch application failed.");
                    }

                    // --- Percentage Squishing Logic ---
                    const buildParentToChildrenMap = (document: GraphDocument): Record<string, string[]> => {
                        const map: Record<string, string[]> = {};
                        for (const nodeId in document.nodes) {
                            const node = document.nodes[nodeId];
                            node.parents.forEach((parentId) => {
                                if (!map[parentId]) {
                                    map[parentId] = [];
                                }
                                map[parentId].push(nodeId);
                            });
                        }
                        return map;
                    };

                    const originalParentMap = buildParentToChildrenMap(originalDoc);
                    const newParentMap = buildParentToChildrenMap(patchedDoc);

                    const affectedParents = new Set<string>();

                    for (const parentId in newParentMap) {
                        const originalChildren = originalParentMap[parentId] || [];
                        const newChildren = newParentMap[parentId];
                        if (newChildren.length > originalChildren.length) {
                            affectedParents.add(parentId);
                        }
                    }

                    affectedParents.forEach((parentId) => {
                        const children = newParentMap[parentId];
                        if (children && children.length > 0) {
                            const newPercentage = 100 / children.length;
                            children.forEach((childId) => {
                                if (patchedDoc.nodes[childId]) {
                                    patchedDoc.nodes[childId].percentage_of_parent = newPercentage;
                                }
                            });
                        }
                    });

                    const patchedDocNormalized = this.normalizeGraphDocument(patchedDoc);
                    const originalDocNormalized = this.normalizeGraphDocument(originalDoc);

                    const hasChanged = !this.documentsAreEqual(originalDocNormalized, patchedDocNormalized);

                    if (!hasChanged) {
                        console.log("No changes detected after applying patch.");
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    score_context: calculateScores(originalDocNormalized.nodes),
                                    result: originalDocNormalized,
                                }),
                            }],
                        };
                    }

                    await this.updateGraphDocument(patchedDocNormalized);
                    console.log("Successfully updated graph document in Supabase.");

                    const versionId = await this.createGraphDocumentVersion(patchedDocNormalized);
                    console.log(`Created graph document version: ${versionId}`);

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                score_context: calculateScores(patchedDocNormalized.nodes),
                                result: patchedDocNormalized,
                                graph_document_version_id: versionId,
                            }),
                        }],
                    };
                } catch (error: any) {
                    console.error("Caught error in patch_graph_document:", error);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "patch_graph_document",
                                status: "failed",
                                error: error.message,
                                stack: error.stack,
                            }),
                        }],
                    };
                }
            }
        );

        this.server.tool(
            "get_graph_document_version",
            {
                version_id: z.string().describe("The UUID of the graph document version to retrieve."),
            },
            async ({ version_id }) => {
                console.log(`Attempting to execute get_graph_document_version for version_id: ${version_id}`);
                try {
                    const versionDoc = await this.getGraphDocumentVersionById(version_id);
                    if (!versionDoc) {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    tool: "get_graph_document_version",
                                    status: "failed",
                                    error: "Version not found",
                                }),
                            }],
                        };
                    }

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                result: versionDoc,
                            }),
                        }],
                    };
                } catch (error: any) {
                    console.error("Caught error in get_graph_document_version:", error);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "get_graph_document_version",
                                status: "failed",
                                error: error.message,
                                stack: error.stack,
                            }),
                        }],
                    };
                }
            }
        );

        this.server.tool(
            "set_graph_document_to_version",
            {
                version_id: z.string().describe("The UUID of the graph document version to restore."),
            },
            async ({ version_id }) => {
                console.log(`Attempting to execute set_graph_document_to_version for version_id: ${version_id}`);
                try {
                    const versionDoc = await this.getGraphDocumentVersionById(version_id);
                    if (!versionDoc) {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    tool: "set_graph_document_to_version",
                                    status: "failed",
                                    error: "Version not found",
                                }),
                            }],
                        };
                    }

                    const currentDoc = await this.getGraphDocument();
                    const normalizedCurrent = this.normalizeGraphDocument(currentDoc);
                    const normalizedVersion = this.normalizeGraphDocument(versionDoc);

                    const alreadyCurrent = this.documentsAreEqual(normalizedCurrent, normalizedVersion);

                    if (alreadyCurrent) {
                        console.log("Live graph already matches requested version. No updates performed.");
                        const normalizedCurrentForReturn = this.normalizeGraphDocument(currentDoc);
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    result: normalizedCurrentForReturn,
                                    score_context: calculateScores(normalizedCurrentForReturn.nodes),
                                }),
                            }],
                        };
                    }

                    const versionDocClone: GraphDocument = JSON.parse(JSON.stringify(versionDoc));
                    await this.updateGraphDocument(versionDocClone);
                    console.log("Successfully set live graph to requested version.");

                    const newVersionId = await this.createGraphDocumentVersion(versionDocClone);
                    console.log(`Created new snapshot after restoring version: ${newVersionId}`);

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                result: versionDocClone,
                                score_context: calculateScores(this.normalizeGraphDocument(versionDocClone).nodes),
                                graph_document_version_id: newVersionId,
                            }),
                        }],
                    };
                } catch (error: any) {
                    console.error("Caught error in set_graph_document_to_version:", error);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "set_graph_document_to_version",
                                status: "failed",
                                error: error.message,
                                stack: error.stack,
                            }),
                        }],
                    };
                }
            }
        );

        this.server.tool(
            "get_or_create_default_graph_version",
            {},
            async () => {
                console.log("Attempting to execute get_or_create_default_graph_version...");
                try {
                    const { data, error } = await supabase
                        .from('graph_document_versions')
                        .select('id, created_at')
                        .order('created_at', { ascending: true })
                        .limit(1);

                    if (error) {
                        throw new Error(`Failed to query graph document versions: ${error.message}`);
                    }

                    if (data && data.length > 0) {
                        const defaultVersionId = data[0].id as string;
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    default_graph_document_version_id: defaultVersionId,
                                    was_created_now: false,
                                }),
                            }],
                        };
                    }

                    const currentDoc = await this.getGraphDocument();
                    const normalizedCurrent = this.normalizeGraphDocument(currentDoc);
                    const createdVersionId = await this.createGraphDocumentVersion(normalizedCurrent);
                    console.log(`Created default graph document version: ${createdVersionId}`);

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                default_graph_document_version_id: createdVersionId,
                                was_created_now: true,
                            }),
                        }],
                    };
                } catch (error: any) {
                    console.error("Caught error in get_or_create_default_graph_version:", error);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "get_or_create_default_graph_version",
                                status: "failed",
                                error: error.message,
                                stack: error.stack,
                            }),
                        }],
                    };
                }
            }
        );
    }
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function withCors(response: Response) {
    const headers = new Headers(response.headers);
    Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsPreflight() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function handleTranscription(request: Request, env: Env) {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    const groqApiKey = env.GROQ_API_KEY;
    if (!groqApiKey) {
        return new Response('API key for Groq not configured', { status: 500, headers: CORS_HEADERS });
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
        return new Response('No file uploaded', { status: 400, headers: CORS_HEADERS });
    }

    const body = new FormData();
    body.append('file', file);
    body.append('model', 'whisper-large-v3');

    const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${groqApiKey}`,
        },
        body,
    });

    return withCors(
        new Response(groqResponse.body, {
            status: groqResponse.status,
            statusText: groqResponse.statusText,
            headers: { 'Content-Type': 'application/json' },
        })
    );
}


export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return corsPreflight();
        }

        if (url.pathname === '/api/transcribe') {
            return handleTranscription(request, env);
        }

        let response: Response;

        if (url.pathname === "/sse" || url.pathname === "/sse/message") {
            response = await MyMCP.serveSSE("/sse").fetch(request, env, ctx);
            return withCors(response);
        }
        if (url.pathname === "/mcp") {
            response = await MyMCP.serve("/mcp").fetch(request, env, ctx);
            return withCors(response);
        }

        response = new Response("Not found", { status: 404, headers: CORS_HEADERS });
        return response;
    },
};
