import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVICE_ACCOUNT } from "./config";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Google Calendar Batch MCP",
		version: "1.0.0",
	});

	// Cache for access token
	private accessToken: string | null = null;
	private tokenExpiry: number = 0;

	// Convert base64 to base64url
	private base64ToBase64url(base64: string): string {
		return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	}

	// Import private key for signing
	private async importPrivateKey(pem: string): Promise<CryptoKey> {
		// Remove PEM headers and newlines
		const pemContents = pem
			.replace("-----BEGIN PRIVATE KEY-----", "")
			.replace("-----END PRIVATE KEY-----", "")
			.replace(/\s/g, "");
		
		// Decode base64
		const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
		
		// Import key
		return await crypto.subtle.importKey(
			"pkcs8",
			binaryDer,
			{
				name: "RSASSA-PKCS1-v1_5",
				hash: "SHA-256",
			},
			false,
			["sign"]
		);
	}

	// Create and sign JWT for service account
	private async createSignedJWT(): Promise<string> {
		const header = {
			alg: "RS256",
			typ: "JWT"
		};

		const now = Math.floor(Date.now() / 1000);
		const payload = {
			iss: SERVICE_ACCOUNT.client_email,
			scope: "https://www.googleapis.com/auth/calendar",
			aud: SERVICE_ACCOUNT.token_uri,
			exp: now + 3600,
			iat: now
		};

		// Encode header and payload
		const encodedHeader = this.base64ToBase64url(btoa(JSON.stringify(header)));
		const encodedPayload = this.base64ToBase64url(btoa(JSON.stringify(payload)));
		const unsignedToken = `${encodedHeader}.${encodedPayload}`;

		// Sign the token
		const privateKey = await this.importPrivateKey(SERVICE_ACCOUNT.private_key);
		const signature = await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			privateKey,
			new TextEncoder().encode(unsignedToken)
		);

		// Convert signature to base64url
		const encodedSignature = this.base64ToBase64url(
			btoa(String.fromCharCode(...new Uint8Array(signature)))
		);

		return `${unsignedToken}.${encodedSignature}`;
	}

	// Get access token using service account
	private async getServiceAccountToken(): Promise<string> {
		// Check if cached token is still valid
		if (this.accessToken && Date.now() < this.tokenExpiry) {
			return this.accessToken;
		}

		// Create signed JWT
		const jwt = await this.createSignedJWT();

		// Exchange JWT for access token
		const response = await fetch(SERVICE_ACCOUNT.token_uri, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: jwt,
			}),
		});

		const data = await response.json();
		
		if (data.access_token) {
			this.accessToken = data.access_token;
			this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // Refresh 1 min early
			return data.access_token;
		}
		
		throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
	}

	// Format calendar events into compact summary
	private formatCalendarSummary(events: any[], includeDesc: boolean): string {
		// Color map - single letter codes
		const colorMap: { [key: string]: string } = {
			'1': 'Lav',  // Lavender
			'2': 'Sage', // Sage
			'3': 'Purp', // Purple
			'4': 'Red',  // Red
			'5': 'Yel',  // Yellow
			'6': 'Org',  // Orange
			'7': 'Turq', // Turquoise
			'8': 'Gray', // Gray
			'9': 'Blue', // Blue
			'10': 'Grn', // Green
			'11': 'Red'  // Red (duplicate)
		};
		
		// Group events by day
		const eventsByDay: { [key: string]: any[] } = {};
		
		events.forEach(event => {
			if (!event.start) return;
			
			// Get the date key
			let dateKey: string;
			let timeStr: string;
			
			if (event.start.date) {
				// All-day event
				dateKey = event.start.date;
				timeStr = 'ALL-DAY';
			} else if (event.start.dateTime) {
				// Timed event
				const startDate = new Date(event.start.dateTime);
				const endDate = new Date(event.end.dateTime);
				
				// Format date as YYYY-MM-DD
				dateKey = startDate.toISOString().split('T')[0];
				
				// Format time as HH:MM-HH:MM in local time
				const startHours = startDate.getHours().toString().padStart(2, '0');
				const startMinutes = startDate.getMinutes().toString().padStart(2, '0');
				const endHours = endDate.getHours().toString().padStart(2, '0');
				const endMinutes = endDate.getMinutes().toString().padStart(2, '0');
				timeStr = `${startHours}:${startMinutes}-${endHours}:${endMinutes}`;
			} else {
				return; // Skip if no valid start
			}
			
			if (!eventsByDay[dateKey]) {
				eventsByDay[dateKey] = [];
			}
			
			// Build event line
			let eventLine = `${timeStr} ${event.summary || 'Untitled'}`;
			
			// Add color if present
			if (event.colorId) {
				eventLine += ` [${colorMap[event.colorId] || event.colorId}]`;
			}
			
			// Add description if requested and present
			if (includeDesc && event.description) {
				// Truncate description to first 50 chars
				const desc = event.description.replace(/\n/g, ' ').slice(0, 50);
				eventLine += ` - ${desc}${event.description.length > 50 ? '...' : ''}`;
			}
			
			eventsByDay[dateKey].push({
				line: eventLine,
				sortKey: timeStr === 'ALL-DAY' ? '00:00' : timeStr
			});
		});
		
		// Format output
		const days = Object.keys(eventsByDay).sort();
		const output: string[] = [];
		
		days.forEach(day => {
			const date = new Date(day + 'T12:00:00');
			const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
			
			output.push(`${day} ${dayName}:`);
			
			// Sort events by time within day
			eventsByDay[day].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
			
			// Add events
			eventsByDay[day].forEach(event => {
				output.push(event.line);
			});
			
			output.push(''); // Empty line between days
		});
		
		return output.join('\n').trim();
	}

	async init() {
		// Simple addition tool
		this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}));

		// Calculator tool with multiple operations
		this.server.tool(
			"calculate",
			{
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			},
			async ({ operation, a, b }) => {
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "subtract":
						result = a - b;
						break;
					case "multiply":
						result = a * b;
						break;
					case "divide":
						if (b === 0)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot divide by zero",
									},
								],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			},
		);

		// Google Calendar Batch Operations with Service Account
		this.server.tool(
			"google_calendar_batch",
			{
				batch_body: z.string().describe("The multipart/mixed batch request body"),
			},
			async ({ batch_body }) => {
				try {
					// Get access token using service account
					const accessToken = await this.getServiceAccountToken();
					
					const response = await fetch("https://www.googleapis.com/batch/calendar/v3", {
						method: "POST",
						headers: {
							"Content-Type": "multipart/mixed; boundary=batch_boundary",
							"Authorization": `Bearer ${accessToken}`,
						},
						body: batch_body,
					});
					
					const responseText = await response.text();
					
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: response.status,
									statusText: response.statusText,
									body: responseText,
								}, null, 2),
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${error.message}`,
							},
						],
					};
				}
			},
		);

		// List Calendar Events (useful for getting event IDs)
		this.server.tool(
			"list_calendar_events",
			{
				calendar_id: z.string().optional().default("primary"),
				max_results: z.number().optional().default(10),
			},
			async ({ calendar_id, max_results }) => {
				try {
					const accessToken = await this.getServiceAccountToken();
					
					const response = await fetch(
						`https://www.googleapis.com/calendar/v3/calendars/${calendar_id}/events?maxResults=${max_results}`,
						{
							method: "GET",
							headers: {
								"Authorization": `Bearer ${accessToken}`,
							},
						}
					);
					
					const data = await response.json();
					
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(data, null, 2),
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${error.message}`,
							},
						],
					};
				}
			},
		);

		// Get Calendar Summary - Compact view of events in date range
		this.server.tool(
			"get_calendar_summary",
			{
				calendar_id: z.string().describe("Calendar ID (email address)"),
				start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date in YYYY-MM-DD format"),
				end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date in YYYY-MM-DD format"),
				include_description: z.boolean().optional().default(false).describe("Include truncated descriptions in output"),
			},
			async ({ calendar_id, start_date, end_date, include_description }) => {
				try {
					const accessToken = await this.getServiceAccountToken();
					
					// Fetch all events in date range with pagination
					let allEvents: any[] = [];
					let pageToken: string | null = null;
					
					// Convert dates to ISO format with timezone
					const timeMin = new Date(start_date + 'T00:00:00-06:00').toISOString();
					const timeMax = new Date(end_date + 'T23:59:59-06:00').toISOString();
					
					do {
						const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events`);
						url.searchParams.set('timeMin', timeMin);
						url.searchParams.set('timeMax', timeMax);
						url.searchParams.set('singleEvents', 'true');
						url.searchParams.set('orderBy', 'startTime');
						url.searchParams.set('maxResults', '250');
						url.searchParams.set('timeZone', 'America/Chicago');
						if (pageToken) {
							url.searchParams.set('pageToken', pageToken);
						}
						
						const response = await fetch(url.toString(), {
							headers: {
								'Authorization': `Bearer ${accessToken}`,
								'Accept': 'application/json'
							}
						});
						
						if (!response.ok) {
							throw new Error(`Calendar API error: ${response.status} ${response.statusText}`);
						}
						
						const data = await response.json();
						allEvents = allEvents.concat(data.items || []);
						pageToken = data.nextPageToken || null;
					} while (pageToken);
					
					// Format events into summary
					const summary = this.formatCalendarSummary(allEvents, include_description);
					
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									summary: summary,
									event_count: allEvents.length,
									date_range: `${start_date} to ${end_date}`
								}, null, 2),
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${error.message}`,
							},
						],
					};
				}
			},
		);

		// HTTP Batch Request tool for general use
		this.server.tool(
			"http_batch_request",
			{
				url: z.string(),
				method: z.string().optional().default("POST"),
				headers: z.record(z.string()).optional(),
				body: z.string().optional(),
			},
			async ({ url, method, headers, body }) => {
				try {
					const response = await fetch(url, {
						method: method,
						headers: headers || {},
						body: body,
					});
					
					const responseText = await response.text();
					
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									status: response.status,
									statusText: response.statusText,
									body: responseText,
									headers: Object.fromEntries(response.headers.entries()),
								}, null, 2),
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${error.message}`,
							},
						],
					};
				}
			},
		);

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
					// @ts-ignore - env will have these
					const supabaseUrl = env.SUPABASE_URL;
					// @ts-ignore
					const supabaseKey = env.SUPABASE_SERVICE_KEY;
					
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
					// @ts-ignore
					const supabaseUrl = env.SUPABASE_URL;
					// @ts-ignore
					const supabaseKey = env.SUPABASE_SERVICE_KEY;
					
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
					// @ts-ignore
					const supabaseUrl = env.SUPABASE_URL;
					// @ts-ignore
					const supabaseKey = env.SUPABASE_SERVICE_KEY;
					
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
					// @ts-ignore
					const supabaseUrl = env.SUPABASE_URL;
					// @ts-ignore
					const supabaseKey = env.SUPABASE_SERVICE_KEY;
					
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
