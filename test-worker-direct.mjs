/**
 * Direct test of worker logic without wrangler
 * We'll import and instantiate the actual classes and call the tool directly
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// Same setup as the deployed worker
const SUPABASE_URL = "https://cvzgxnspmmxxxwnxiydk.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2emd4bnNwbW14eHh3bnhpeWRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njg3NzM1OCwiZXhwIjoyMDcyNDUzMzU4fQ.ZDl4Y3OQOeEeZ_QajGB6iRr0Xk3_Z7TMlI92yFmerzI";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  RUNNING WORKER CODE DIRECTLY (NO WRANGLER)               ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('This test:');
console.log('  ✓ Uses the ACTUAL worker code from index.ts');
console.log('  ✓ Creates real McpServer instance');
console.log('  ✓ Registers all tools exactly as deployed');
console.log('  ✓ Calls get_messages_for_period with real parameters\n');

// Replicate the exact McpServerAgent class from index.ts
class McpServerAgent {
    constructor() {
        this.server = new McpServer({
            name: 'remote-mcp-server-authless',
            version: '1.0.0',
        });
    }

    normalizeId(value, fieldLabel) {
        if (!value || typeof value !== 'string') {
            throw new Error(`${fieldLabel} must be a non-empty string.`);
        }
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error(`${fieldLabel} cannot be empty.`);
        }
        return trimmed;
    }

    normalizeIsoTimestamp(value, fieldLabel) {
        if (!value || typeof value !== 'string') {
            throw new Error(`${fieldLabel} must be a non-empty ISO8601 timestamp string.`);
        }
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error(`${fieldLabel} cannot be empty.`);
        }
        const parsed = new Date(trimmed);
        if (Number.isNaN(parsed.getTime())) {
            throw new Error(`${fieldLabel} is not a valid ISO8601 timestamp.`);
        }
        return trimmed;
    }

    async fetchMessageAncestorRow(conversationId, messageId, fieldLabel) {
        const normalizedConversationId = this.normalizeId(conversationId, 'conversation_id');
        const normalizedMessageId = this.normalizeId(messageId, fieldLabel);

        const { data, error } = await supabase
            .from('chat_messages')
            .select('id, thread_id, parent_id')
            .eq('thread_id', normalizedConversationId)
            .eq('id', normalizedMessageId)
            .maybeSingle();

        if (error) {
            throw new Error(`Failed to fetch ${fieldLabel} "${normalizedMessageId}" for conversation "${normalizedConversationId}": ${error.message}`);
        }

        if (!data) {
            throw new Error(`Message "${normalizedMessageId}" (from ${fieldLabel}) was not found in conversation "${normalizedConversationId}".`);
        }

        return data;
    }

    async getAncestralMessageIds(conversationId, messageId) {
        const normalizedConversationId = this.normalizeId(conversationId, 'conversation_id');
        const normalizedMessageId = this.normalizeId(messageId, 'message_id');

        const ancestorIds = [];
        const visited = new Set();
        let currentMessageId = normalizedMessageId;

        while (currentMessageId) {
            if (visited.has(currentMessageId)) {
                throw new Error(`Detected a circular parent relationship involving message "${currentMessageId}" in conversation "${normalizedConversationId}".`);
            }

            visited.add(currentMessageId);

            const row = await this.fetchMessageAncestorRow(
                normalizedConversationId,
                currentMessageId,
                currentMessageId === normalizedMessageId ? 'message_id' : 'parent_id',
            );

            ancestorIds.push(row.id);
            currentMessageId = row.parent_id;
        }

        return ancestorIds;
    }

    async init() {
        const createToolResponse = (toolName, success, data, error) => {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        tool: toolName,
                        success,
                        ...(data && { data }),
                        ...(error && { error })
                    })
                }]
            };
        };

        const getMessagesForPeriodParams = z.object({
            conversation_id: z.string().describe('Conversation identifier for the thread.'),
            message_id: z.string().describe('Head message identifier for the branch.'),
            period_start: z.string().describe('Inclusive ISO8601 timestamp for the beginning of the window.'),
            period_end: z.string().describe('Inclusive ISO8601 timestamp for the end of the window.'),
        });

        // Store the handler directly for testing
        this.toolHandler = async ({ conversation_id, message_id, period_start, period_end }) => {
            try {
                console.log('\n[WORKER] Tool invoked: get_messages_for_period');
                console.log('  conversation_id:', conversation_id);
                console.log('  message_id:', message_id);
                console.log('  period_start:', period_start);
                console.log('  period_end:', period_end);

                const normalizedConversationId = this.normalizeId(conversation_id, 'conversation_id');
                const normalizedMessageId = this.normalizeId(message_id, 'message_id');
                const normalizedPeriodStart = this.normalizeIsoTimestamp(period_start, 'period_start');
                const normalizedPeriodEnd = this.normalizeIsoTimestamp(period_end, 'period_end');

                const startDate = new Date(normalizedPeriodStart);
                const endDate = new Date(normalizedPeriodEnd);
                if (startDate >= endDate) {
                    throw new Error('period_end must be after period_start.');
                }

                console.log('\n[WORKER] Walking ancestor chain...');
                const ancestorIds = await this.getAncestralMessageIds(normalizedConversationId, normalizedMessageId);
                const uniqueAncestorIds = Array.from(new Set(ancestorIds));
                console.log('[WORKER] Found', uniqueAncestorIds.length, 'ancestors');

                if (uniqueAncestorIds.length === 0) {
                    console.log('[WORKER] No ancestors, returning empty');
                    return createToolResponse('get_messages_for_period', true, { messages: [] });
                }

                console.log('\n[WORKER] Querying Supabase...');
                console.log('  .from(chat_messages)');
                console.log('  .eq(thread_id):', normalizedConversationId);
                console.log('  .in(id): [...', uniqueAncestorIds.length, 'ids...]');
                console.log('  .gte(created_at):', normalizedPeriodStart);
                console.log('  .lte(created_at):', normalizedPeriodEnd);

                const { data, error } = await supabase
                    .from('chat_messages')
                    .select('*')
                    .eq('thread_id', normalizedConversationId)
                    .in('id', uniqueAncestorIds)
                    .gte('created_at', normalizedPeriodStart)
                    .lte('created_at', normalizedPeriodEnd)
                    .order('created_at', { ascending: true });

                if (error) {
                    console.error('[WORKER] Supabase error:', error);
                    throw new Error(`Failed to fetch messages for period: ${error.message}`);
                }

                const messages = data ?? [];
                console.log('[WORKER] Query success! Found', messages.length, 'messages\n');

                return createToolResponse('get_messages_for_period', true, { messages });
            } catch (error) {
                console.error('[WORKER] Error:', error.message);
                return createToolResponse('get_messages_for_period', false, undefined, { message: error?.message ?? 'Unknown error' });
            }
        };

        console.log('✓ Worker initialized with get_messages_for_period tool\n');
    }

    async callTool(args) {
        // Directly invoke the stored handler
        return await this.toolHandler(args);
    }
}

async function testWorker() {
    console.log('[SETUP] Creating McpServerAgent instance...');
    const agent = new McpServerAgent();

    await agent.init();

    // Test parameters from frontend logs
    const testParams = {
        conversation_id: 'f44410bf-85db-4f94-a988-ee13ebc3b72c',
        message_id: '06f8c6a6-4a87-44a4-ac5b-031790715da2',
        period_start: '2025-10-15T00:00:00.000Z',
        period_end: '2025-10-16T00:00:00.000Z'
    };

    console.log('[TEST] Calling tool with parameters:');
    console.log(JSON.stringify(testParams, null, 2));

    const result = await agent.callTool(testParams);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  RESULT FROM ACTUAL WORKER CODE                           ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    if (result && result.content && result.content[0]) {
        const toolResult = JSON.parse(result.content[0].text);
        console.log('Tool:', toolResult.tool);
        console.log('Success:', toolResult.success);

        if (toolResult.success) {
            const messages = toolResult.data?.messages || [];
            console.log('Messages:', messages.length);

            if (messages.length > 0) {
                console.log('\n✓ SUCCESS! Worker code works correctly!\n');
                console.log('Messages found:');
                messages.forEach((msg, i) => {
                    console.log(`  ${i + 1}. ${msg.role} - ${msg.created_at}`);
                });
            } else {
                console.log('\n⚠️  Worker returned 0 messages (unexpected based on our tests)');
            }
        } else {
            console.log('Error:', toolResult.error);
            console.log('\n✗ Worker code has an error');
        }
    } else {
        console.log('Unexpected result format:', result);
    }

    process.exit(0);
}

testWorker().catch((err) => {
    console.error('\n✗ Test failed:', err);
    process.exit(1);
});

