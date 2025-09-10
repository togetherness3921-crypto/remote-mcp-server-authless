import { z } from "zod";
import { SERVICE_ACCOUNT } from "./config";

export class GoogleCalendarTools {
    private accessToken: string | null = null;
    private tokenExpiry: number = 0;

    // Convert base64 to base64url
    private base64ToBase64url(base64: string): string {
        return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    }

    // Import private key for signing
    private async importPrivateKey(pem: string): Promise<CryptoKey> {
        const pemContents = pem
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replace(/\s/g, "");
        
        const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
        
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

        const encodedHeader = this.base64ToBase64url(btoa(JSON.stringify(header)));
        const encodedPayload = this.base64ToBase64url(btoa(JSON.stringify(payload)));
        const unsignedToken = `${encodedHeader}.${encodedPayload}`;

        const privateKey = await this.importPrivateKey(SERVICE_ACCOUNT.private_key);
        const signature = await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            privateKey,
            new TextEncoder().encode(unsignedToken)
        );

        const encodedSignature = this.base64ToBase64url(
            btoa(String.fromCharCode(...new Uint8Array(signature)))
        );

        return `${unsignedToken}.${encodedSignature}`;
    }

    // Get access token using service account
    async getServiceAccountToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        const jwt = await this.createSignedJWT();

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
            this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
            return data.access_token;
        }
        
        throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
    }

    // Format calendar events into compact summary
    formatCalendarSummary(events: any[], includeDesc: boolean): string {
        const colorMap: { [key: string]: string } = {
            '1': 'Lav',
            '2': 'Sage',
            '3': 'Purp',
            '4': 'Red',
            '5': 'Yel',
            '6': 'Org',
            '7': 'Turq',
            '8': 'Gray',
            '9': 'Blue',
            '10': 'Grn',
            '11': 'Red'
        };
        
        const eventsByDay: { [key: string]: any[] } = {};
        
        events.forEach(event => {
            if (!event.start) return;
            
            let dateKey: string;
            let timeStr: string;
            
            if (event.start.date) {
                dateKey = event.start.date;
                timeStr = 'ALL-DAY';
            } else if (event.start.dateTime) {
                const startDate = new Date(event.start.dateTime);
                const endDate = new Date(event.end.dateTime);
                
                dateKey = startDate.toISOString().split('T')[0];
                
                const startHours = startDate.getHours().toString().padStart(2, '0');
                const startMinutes = startDate.getMinutes().toString().padStart(2, '0');
                const endHours = endDate.getHours().toString().padStart(2, '0');
                const endMinutes = endDate.getMinutes().toString().padStart(2, '0');
                timeStr = `${startHours}:${startMinutes}-${endHours}:${endMinutes}`;
            } else {
                return;
            }
            
            if (!eventsByDay[dateKey]) {
                eventsByDay[dateKey] = [];
            }
            
            let eventLine = `${timeStr} ${event.summary || 'Untitled'}`;
            
            if (event.colorId) {
                eventLine += ` [${colorMap[event.colorId] || event.colorId}]`;
            }
            
            if (includeDesc && event.description) {
                const desc = event.description.replace(/\n/g, ' ').slice(0, 50);
                eventLine += ` - ${desc}${event.description.length > 50 ? '...' : ''}`;
            }
            
            eventsByDay[dateKey].push({
                line: eventLine,
                sortKey: timeStr === 'ALL-DAY' ? '00:00' : timeStr
            });
        });
        
        const days = Object.keys(eventsByDay).sort();
        const output: string[] = [];
        
        days.forEach(day => {
            const date = new Date(day + 'T12:00:00');
            const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
            
            output.push(`${day} ${dayName}:`);
            eventsByDay[day].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
            eventsByDay[day].forEach(event => {
                output.push(event.line);
            });
            output.push('');
        });
        
        return output.join('\n').trim();
    }

    // Register all Google Calendar tools
    registerTools(server: any, env: any) {
        // Simple addition tool
        server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
            content: [{ type: "text", text: String(a + b) }],
        }));

        // Calculator tool
        server.tool(
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
                                content: [{ type: "text", text: "Error: Cannot divide by zero" }],
                            };
                        result = a / b;
                        break;
                }
                return { content: [{ type: "text", text: String(result) }] };
            },
        );

        // Google Calendar Batch Operations
        server.tool(
            "google_calendar_batch",
            {
                batch_body: z.string().describe("The multipart/mixed batch request body"),
            },
            async ({ batch_body }) => {
                try {
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
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: response.status,
                                statusText: response.statusText,
                                body: responseText,
                            }, null, 2),
                        }],
                    };
                } catch (error) {
                    return {
                        content: [{ type: "text", text: `Error: ${error.message}` }],
                    };
                }
            },
        );

        // List Calendar Events
        server.tool(
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
                        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
                    };
                } catch (error) {
                    return {
                        content: [{ type: "text", text: `Error: ${error.message}` }],
                    };
                }
            },
        );

        // Get Calendar Summary
        server.tool(
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
                    
                    let allEvents: any[] = [];
                    let pageToken: string | null = null;
                    
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
                    
                    const summary = this.formatCalendarSummary(allEvents, include_description);
                    
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                summary: summary,
                                event_count: allEvents.length,
                                date_range: `${start_date} to ${end_date}`
                            }, null, 2),
                        }],
                    };
                } catch (error) {
                    return {
                        content: [{ type: "text", text: `Error: ${error.message}` }],
                    };
                }
            },
        );

        // HTTP Batch Request tool
        server.tool(
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
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: response.status,
                                statusText: response.statusText,
                                body: responseText,
                                headers: Object.fromEntries(response.headers.entries()),
                            }, null, 2),
                        }],
                    };
                } catch (error) {
                    return {
                        content: [{ type: "text", text: `Error: ${error.message}` }],
                    };
                }
            },
        );
    }
}
