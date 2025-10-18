import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Operation, applyPatch } from "fast-json-patch";
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
const SUPABASE_URL = "https://cvzgxnspmmxxxwnxiydk.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2emd4bnNwbW14eHh3bnhpeWRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njg3NzM1OCwiZXhwIjoyMDcyNDUzMzU4fQ.ZDl4Y3OQOeEeZ_QajGB6iRr0Xk3_Z7TMlI92yFmerzI";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

type JSONPatch = Operation[];

const ALLOWED_STATUSES: Array<Node['status']> = ['not-started', 'in-progress', 'completed'];
const ALLOWED_STATUS_SET = new Set(ALLOWED_STATUSES);
const DEFAULT_STATUS: Node['status'] = 'not-started';
const ALLOWED_NODE_TYPE = 'objectiveNode';

const normalizeNode = (nodeId: string, node: any) => {
    let rawType = node?.type;
    if (typeof rawType === 'string') {
        const lowered = rawType.trim().toLowerCase();
        if (lowered === 'objectivenode') {
            rawType = ALLOWED_NODE_TYPE;
        }
    }
    if (!rawType) {
        rawType = ALLOWED_NODE_TYPE;
    }
    if (rawType !== ALLOWED_NODE_TYPE) {
        throw new Error(`Invalid node type "${rawType}" for node "${nodeId}". See Graph Contract v1.0.`);
    }
    node.type = ALLOWED_NODE_TYPE;

    const graphValue = node?.graph;
    if (typeof graphValue !== 'string') {
        throw new Error(`Node "${nodeId}" is missing the required 'graph' property. Set it to "main" or another node's id.`);
    }
    const trimmedGraph = graphValue.trim();
    if (!trimmedGraph) {
        throw new Error(`Node "${nodeId}" has an empty 'graph' value. Set it to "main" or another node's id.`);
    }
    const normalizedGraph = trimmedGraph.toLowerCase() === 'main' ? 'main' : trimmedGraph;
    node.graph = normalizedGraph;

    if (node.status === undefined || node.status === null || node.status === '') {
        return;
    }
    if (typeof node.status !== 'string') {
        throw new Error(`Invalid status for node "${nodeId}". Status must be a string matching the Graph Contract v1.0 enum.`);
    }
    const trimmedStatus = node.status.trim();
    if (ALLOWED_STATUS_SET.has(trimmedStatus as Node['status'])) {
        node.status = trimmedStatus as Node['status'];
        return;
    }
    if (trimmedStatus.toLowerCase() === 'pending') {
        node.status = DEFAULT_STATUS;
        return;
    }
    throw new Error(`Invalid status "${trimmedStatus}" for node "${nodeId}". Allowed statuses: ${ALLOWED_STATUSES.join(', ')}.`);
};

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

        normalizeNode(nodeId, node);

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
    status: "not-started" | "in-progress" | "completed";
    parents: string[];
    percentage_of_parent: number;
    createdAt: string;
    graph: string;
    scheduled_start?: string;
    true_percentage_of_total?: number;
}

const enforceGraphMembership = (nodes: Record<string, Node>) => {
    const nodeIds = new Set(Object.keys(nodes));
    const containmentTargets = new Map<string, string>();

    for (const [nodeId, node] of Object.entries(nodes)) {
        const graphTarget = node.graph;
        if (graphTarget === 'main') {
            continue;
        }

        if (!nodeIds.has(graphTarget)) {
            throw new Error(`Node "${nodeId}" references unknown graph container "${graphTarget}". Create that node first or choose a different container.`);
        }

        if (graphTarget === nodeId) {
            throw new Error(`Node "${nodeId}" cannot assign itself as its graph container. Use "main" or a different node id.`);
        }

        containmentTargets.set(nodeId, graphTarget);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();

    const detectCycle = (nodeId: string, stack: string[]) => {
        if (visiting.has(nodeId)) {
            const cycleStart = stack.indexOf(nodeId);
            const cyclePath = cycleStart >= 0 ? stack.slice(cycleStart) : [...stack];
            cyclePath.push(nodeId);
            throw new Error(`Graph containment cycle detected via the 'graph' property: ${cyclePath.join(' -> ')}. Update the 'graph' values to break the cycle.`);
        }

        if (visited.has(nodeId)) {
            return;
        }

        visiting.add(nodeId);
        stack.push(nodeId);

        const container = containmentTargets.get(nodeId);
        if (container && containmentTargets.has(container)) {
            detectCycle(container, stack);
        }

        stack.pop();
        visiting.delete(nodeId);
        visited.add(nodeId);
    };

    containmentTargets.forEach((_container, nodeId) => {
        if (!visited.has(nodeId)) {
            detectCycle(nodeId, []);
        }
    });
};

const normalizeGraphDocument = (document: GraphDocument): GraphDocument => {
    if (!document.nodes || typeof document.nodes !== 'object') {
        document.nodes = {};
        return document;
    }

    Object.entries(document.nodes).forEach(([nodeId, node]) => {
        normalizeNode(nodeId, node);
    });

    enforceGraphMembership(document.nodes);

    return document;
};

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

type NodeWithChildren = Node & { children: Record<string, NodeWithChildren> };

const buildHierarchicalNodes = (nodes: Record<string, Node>): Record<string, NodeWithChildren> => {
    const nodeIds = Object.keys(nodes);
    if (nodeIds.length === 0) {
        return {};
    }

    const subset = new Set(nodeIds);
    const clones: Record<string, NodeWithChildren> = {};

    for (const nodeId of nodeIds) {
        const node = nodes[nodeId];
        if (!node) {
            continue;
        }
        clones[nodeId] = {
            ...node,
            children: {}
        };
    }

    const rootIds = new Set(nodeIds);

    for (const nodeId of nodeIds) {
        const node = nodes[nodeId];
        if (!node) {
            continue;
        }

        const parents = Array.isArray(node.parents) ? node.parents : [];
        for (const parentId of parents) {
            if (subset.has(parentId) && clones[parentId]) {
                clones[parentId].children[nodeId] = clones[nodeId];
                rootIds.delete(nodeId);
            }
        }
    }

    const hierarchical: Record<string, NodeWithChildren> = {};
    rootIds.forEach(rootId => {
        hierarchical[rootId] = clones[rootId];
    });

    return hierarchical;
};


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

        return normalizeGraphDocument(data[0].data);
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

    private async createGraphDocumentVersion(document: GraphDocument): Promise<string> {
        const { data, error } = await supabase
            .from('graph_document_versions')
            .insert({ data: document })
            .select('id')
            .single();

        if (error) {
            throw new Error(`Failed to create graph document version: ${error.message}`);
        }

        return data.id;
    }

    private async fetchGraphDocumentVersion(versionId: string): Promise<GraphDocument | null> {
        const { data, error } = await supabase
            .from('graph_document_versions')
            .select('data')
            .eq('id', versionId)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return null;
            }
            throw new Error(`Failed to fetch graph document version: ${error.message}`);
        }

        if (!data) {
            return null;
        }

        return normalizeGraphDocument(data.data as GraphDocument);
    }

    private async getEarliestGraphDocumentVersionId(): Promise<string | null> {
        const { data, error } = await supabase
            .from('graph_document_versions')
            .select('id')
            .order('created_at', { ascending: true })
            .limit(1);

        if (error) {
            throw new Error(`Failed to fetch earliest graph document version: ${error.message}`);
        }

        if (!data || data.length === 0) {
            return null;
        }

        return data[0].id;
    }

    private documentsAreEqual(a: GraphDocument, b: GraphDocument): boolean {
        return JSON.stringify(a) === JSON.stringify(b);
    }


    async init() {
        type MCPCallToolResult = z.infer<typeof CallToolResultSchema>;

        const createToolResponse = (
            tool: string,
            success: boolean,
            data?: Record<string, unknown>,
            error?: { message: string; code?: string }
        ): MCPCallToolResult => {
            const payload: Record<string, unknown> = { tool, success };
            if (data !== undefined) {
                payload.data = data;
            }
            if (error !== undefined) {
                payload.error = error;
            }

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(payload),
                    },
                ],
            };
        };

        const getSystemInstructionsParams = z.object({
            instruction_id: z.string().optional().describe("System use only. Omit this parameter."),
        });

        type GetSystemInstructionsArgs = z.infer<typeof getSystemInstructionsParams> & { instruction_id?: string };

        const updateSystemInstructionsParams = z.object({
            new_instructions_content: z
                .string()
                .describe("The complete new content for the system instructions."),
            instruction_id: z.string().optional().describe("System use only. Omit this parameter."),
            reason: z.string().optional().describe("Brief rationale for the change."),
            change_type: z
                .enum(["refine", "append", "replace"])
                .optional()
                .describe("Intent for the change."),
            dry_run: z.boolean().optional().describe("When true, validate but do not persist."),
        });

        type UpdateSystemInstructionsArgs = z.infer<typeof updateSystemInstructionsParams> & { instruction_id?: string, dry_run?: boolean };

        // 0. Tool to get instructions
        this.server.tool<GetSystemInstructionsArgs>(
            "get_system_instructions",
            getSystemInstructionsParams.shape,
            async (args: GetSystemInstructionsArgs, _extra) => {
                const instructionId = args?.instruction_id;
                console.log("Attempting to execute get_system_instructions...");
                try {
                    if (!instructionId) {
                        throw new Error("System error: instruction_id was not provided by the client.");
                    }
                    console.log(`Fetching system instructions '${instructionId}' from Supabase...`);
                    const { data, error } = await supabase
                        .from('system_instructions')
                        .select('id, content, updated_at')
                        .eq('id', instructionId)
                        .maybeSingle();

                    if (error) {
                        console.error("Error fetching instructions from Supabase:", error);
                        throw new Error(`Supabase error: ${error.message}`);
                    }

                    if (!data) {
                        console.warn(`Instruction '${instructionId}' not found.`);
                        return createToolResponse("get_system_instructions", false, undefined, {
                            message: "Instruction not found",
                            code: "NOT_FOUND",
                        });
                    }

                    console.log("Successfully fetched instructions.");
                    const payloadData: Record<string, unknown> = {
                        instruction_id: data.id,
                        content: data.content,
                        content_length: data.content?.length ?? 0,
                    };

                    if (data.updated_at) {
                        payloadData.updated_at = data.updated_at;
                    }

                    return createToolResponse("get_system_instructions", true, payloadData);
                } catch (error: any) {
                    console.error("Caught error in get_system_instructions:", error);
                    return createToolResponse("get_system_instructions", false, undefined, {
                        message: error?.message ?? "Unknown error",
                    });
                }
            }
        );

        // New Tool: Update Tool Instructions
        this.server.tool<UpdateSystemInstructionsArgs>(
            "update_system_instructions",
            updateSystemInstructionsParams.shape,
            async (args: UpdateSystemInstructionsArgs, _extra) => {
                const { new_instructions_content, instruction_id, dry_run } = args;
                const instructionId = instruction_id;
                console.log("Attempting to execute update_system_instructions...");

                try {
                    if (!instructionId) {
                        throw new Error("System error: instruction_id was not provided by the client.");
                    }

                    const trimmedContent = new_instructions_content.trim();
                    if (trimmedContent.length === 0) {
                        console.warn("Rejected update due to empty instruction content.");
                        return createToolResponse("update_system_instructions", false, undefined, {
                            message: "Instruction content cannot be empty.",
                            code: "EMPTY_CONTENT",
                        });
                    }

                    console.log(`Fetching existing instruction '${instructionId}' for comparison...`);
                    const { data: existingInstruction, error: fetchError } = await supabase
                        .from('system_instructions')
                        .select('id, content')
                        .eq('id', instructionId)
                        .maybeSingle();

                    if (fetchError) {
                        console.error("Error fetching instructions from Supabase:", fetchError);
                        throw new Error(`Supabase error: ${fetchError.message}`);
                    }

                    if (!existingInstruction) {
                        console.warn(`Instruction '${instructionId}' not found for update.`);
                        return createToolResponse("update_system_instructions", false, undefined, {
                            message: "Instruction not found",
                            code: "NOT_FOUND",
                        });
                    }

                    const currentContent = existingInstruction.content ?? "";
                    const currentLength = currentContent.length;
                    const newLength = new_instructions_content.length;

                    if (!dry_run && new_instructions_content === currentContent) {
                        console.log("No changes detected; skipping update.");
                        return createToolResponse("update_system_instructions", true, {
                            instruction_id: instructionId,
                            updated: false,
                            content_length: newLength,
                            summary: "Content is unchanged; no update performed.",
                        });
                    }

                    if (dry_run) {
                        console.log("Dry run enabled; not persisting changes.");
                        return createToolResponse("update_system_instructions", true, {
                            instruction_id: instructionId,
                            updated: false,
                            content_length: newLength,
                            summary: `Dry run: instruction '${instructionId}' would be updated (${currentLength} -> ${newLength} chars).`,
                        });
                    }

                    console.log("Updating system instructions in Supabase...");
                    const { error: updateError } = await supabase
                        .from('system_instructions')
                        .update({ content: new_instructions_content })
                        .eq('id', instructionId);

                    if (updateError) {
                        console.error("Error updating instructions in Supabase:", updateError);
                        throw new Error(`Supabase error: ${updateError.message}`);
                    }

                    console.log("Successfully updated instructions.");
                    return createToolResponse("update_system_instructions", true, {
                        instruction_id: instructionId,
                        updated: true,
                        content_length: newLength,
                        summary: `Instruction '${instructionId}' updated (${currentLength} -> ${newLength} chars).`,
                    });
                } catch (error: any) {
                    console.error("Caught error in update_system_instructions:", error);
                    return createToolResponse("update_system_instructions", false, undefined, {
                        message: error?.message ?? "Unknown error",
                    });
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

                    const hierarchicalContext = buildHierarchicalNodes(resultGraphWithPercentages);

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                current_date: new Date().toISOString(),
                                score_context: calculateScores(doc.nodes),
                                context: hierarchicalContext
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

                    const allNodes = doc.nodes;
                    const currentDate = new Date().toISOString();
                    const scoreContext = calculateScores(allNodes);

                    if (start_node_id === "main") {
                        const nodesWithPercentages = calculateTruePercentages(allNodes);
                        const hierarchicalStructure = buildHierarchicalNodes(nodesWithPercentages);
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    current_date: currentDate,
                                    score_context: scoreContext,
                                    structure: hierarchicalStructure
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

                    const hierarchicalStructure = buildHierarchicalNodes(resultNodesWithPercentages);

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                current_date: currentDate,
                                score_context: scoreContext,
                                structure: hierarchicalStructure
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
                patches: z
                    .string()
                    .describe(
                        "JSON string of RFC 6902 operations. Every node must include its 'graph' field (\"main\" or a containing node id) and otherwise comply with the Graph Contract v1.0 described in the system instructions."
                    ),
            },
            async ({ patches }) => {
                console.log("Attempting to execute patch_graph_document...");
                try {
                    console.log("Fetching graph document for patching...");
                    let doc = await this.getGraphDocument();
                    console.log("Successfully fetched graph document.");

                    const originalDoc = JSON.parse(JSON.stringify(doc)); // Deep copy

                    let parsedPatches: JSONPatch;
                    try {
                        parsedPatches = JSON.parse(patches);
                    } catch (e) {
                        throw new Error("Invalid JSON format for patches string.");
                    }

                    if (!Array.isArray(parsedPatches)) {
                        throw new Error("Patch sequence must be an array.");
                    }

                    // Apply the patches and calculate percentages
                    let patchedDoc = applyPatch(doc, parsedPatches, true, false).newDocument as GraphDocument;
                    if (!patchedDoc) {
                        throw new Error("Patch application failed.");
                    }

                    patchedDoc = normalizeGraphDocument(patchedDoc);
                    patchedDoc.nodes = calculateTruePercentages(patchedDoc.nodes);


                    // --- Percentage Squishing Logic ---

                    // Helper to build a map of parent -> children
                    const buildParentToChildrenMap = (document: GraphDocument): Record<string, string[]> => {
                        const map: Record<string, string[]> = {};
                        for (const nodeId in document.nodes) {
                            const node = document.nodes[nodeId];
                            node.parents.forEach(parentId => {
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

                    // Find parents with new children
                    for (const parentId in newParentMap) {
                        const originalChildren = originalParentMap[parentId] || [];
                        const newChildren = newParentMap[parentId];
                        if (newChildren.length > originalChildren.length) {
                            affectedParents.add(parentId);
                        }
                    }

                    // Recalculate percentages for children of affected parents
                    affectedParents.forEach(parentId => {
                        const children = newParentMap[parentId];
                        if (children && children.length > 0) {
                            const newPercentage = 100 / children.length;
                            children.forEach(childId => {
                                if (patchedDoc.nodes[childId]) {
                                    patchedDoc.nodes[childId].percentage_of_parent = newPercentage;
                                }
                            });
                        }
                    });

                    const hasChanges = !this.documentsAreEqual(originalDoc, patchedDoc);

                    if (!hasChanges) {
                        console.log("No changes detected after applying patches. Skipping update.");
                        const responseDocument = {
                            ...patchedDoc,
                            nodes: buildHierarchicalNodes(patchedDoc.nodes)
                        };
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    score_context: calculateScores(patchedDoc.nodes),
                                    result: responseDocument
                                })
                            }]
                        };
                    }

                    await this.updateGraphDocument(patchedDoc);
                    console.log("Successfully updated graph document in Supabase.");

                    const graphDocumentVersionId = await this.createGraphDocumentVersion(patchedDoc);
                    console.log(`Created graph document version: ${graphDocumentVersionId}`);

                    const responseDocument = {
                        ...patchedDoc,
                        nodes: buildHierarchicalNodes(patchedDoc.nodes)
                    };

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                score_context: calculateScores(patchedDoc.nodes),
                                result: responseDocument,
                                graph_document_version_id: graphDocumentVersionId
                            })
                        }]
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
                                stack: error.stack
                            })
                        }]
                    };
                }
            }
        );

        this.server.tool(
            "get_graph_document_version",
            {
                version_id: z.string().describe("UUID of the graph document version to retrieve."),
            },
            async ({ version_id }) => {
                console.log(`Attempting to execute get_graph_document_version for version: ${version_id}`);
                try {
                    const versionDoc = await this.fetchGraphDocumentVersion(version_id);

                    if (!versionDoc) {
                        console.warn(`Version not found: ${version_id}`);
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    tool: "get_graph_document_version",
                                    status: "failed",
                                    error: "Version not found"
                                })
                            }]
                        };
                    }

                    const responseDocument = {
                        ...versionDoc,
                        nodes: buildHierarchicalNodes(versionDoc.nodes)
                    };

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                result: responseDocument
                            })
                        }]
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
                                stack: error.stack
                            })
                        }]
                    };
                }
            }
        );

        this.server.tool(
            "set_graph_document_to_version",
            {
                version_id: z.string().describe("UUID of the graph document version to set as the live document."),
            },
            async ({ version_id }) => {
                console.log(`Attempting to execute set_graph_document_to_version for version: ${version_id}`);
                try {
                    const versionDoc = await this.fetchGraphDocumentVersion(version_id);

                    if (!versionDoc) {
                        console.warn(`Version not found: ${version_id}`);
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    tool: "set_graph_document_to_version",
                                    status: "failed",
                                    error: "Version not found"
                                })
                            }]
                        };
                    }

                    const currentDoc = await this.getGraphDocument();

                    if (this.documentsAreEqual(currentDoc, versionDoc)) {
                        console.log("Live document already matches requested version. No update required.");
                        const responseDocument = {
                            ...currentDoc,
                            nodes: buildHierarchicalNodes(currentDoc.nodes)
                        };
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    result: responseDocument
                                })
                            }]
                        };
                    }

                    await this.updateGraphDocument(versionDoc);
                    console.log("Live graph document updated to requested version.");

                    const graphDocumentVersionId = await this.createGraphDocumentVersion(versionDoc);
                    console.log(`Created graph document version after set: ${graphDocumentVersionId}`);

                    const responseDocument = {
                        ...versionDoc,
                        nodes: buildHierarchicalNodes(versionDoc.nodes)
                    };

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                result: responseDocument,
                                graph_document_version_id: graphDocumentVersionId
                            })
                        }]
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
                                stack: error.stack
                            })
                        }]
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
                    const existingVersionId = await this.getEarliestGraphDocumentVersionId();

                    if (existingVersionId) {
                        console.log(`Found existing default version: ${existingVersionId}`);
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    success: true,
                                    default_graph_document_version_id: existingVersionId,
                                    was_created_now: false
                                })
                            }]
                        };
                    }

                    const currentDoc = await this.getGraphDocument();
                    const newVersionId = await this.createGraphDocumentVersion(currentDoc);
                    console.log(`Created new default version: ${newVersionId}`);

                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                default_graph_document_version_id: newVersionId,
                                was_created_now: true
                            })
                        }]
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
                                stack: error.stack
                            })
                        }]
                    };
                }
            }
        );

        this.server.tool(
            'get_user_setting',
            {
                key: z.string().describe('The key of the setting to retrieve.'),
            },
            async ({ key }) => {
                try {
                    const { data, error } = await supabase
                        .from('user_settings')
                        .select('value')
                        .eq('key', key)
                        .single();

                    if (error) {
                        if (error.code === 'PGRST116') { // PostgREST code for "Not Found"
                            return { content: [{ type: 'text', text: JSON.stringify({ success: true, value: null }) }] };
                        }
                        throw error;
                    }

                    return { content: [{ type: 'text', text: JSON.stringify({ success: true, value: data.value }) }] };
                } catch (error: any) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ tool: 'get_user_setting', status: 'failed', error: error.message }),
                        }],
                    };
                }
            }
        );

        this.server.tool(
            'set_user_setting',
            {
                key: z.string().describe('The key of the setting to set.'),
                value: z.string().describe('The value to set for the key.'),
            },
            async ({ key, value }) => {
                try {
                    const { error } = await supabase
                        .from('user_settings')
                        .upsert({ key, value });

                    if (error) throw error;

                    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
                } catch (error: any) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ tool: 'set_user_setting', status: 'failed', error: error.message }),
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

    if (!(file instanceof File)) {
        return new Response('Uploaded file must be a file blob', { status: 400, headers: CORS_HEADERS });
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
