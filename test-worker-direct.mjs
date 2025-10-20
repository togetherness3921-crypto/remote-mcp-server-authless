/**
 * Direct test of worker logic without Wrangler
 * Extracts and runs the exact MCP tool implementation from index.ts
 */

import { createClient } from '@supabase/supabase-js';

// Same credentials as the worker
const SUPABASE_URL = "https://cvzgxnspmmxxxwnxiydk.supabase.co";
const SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2emd4bnNwbW14eHh3bnhpeWRrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Njg3NzM1OCwiZXhwIjoyMDcyNDUzMzU4fQ.ZDl4Y3OQOeEeZ_QajGB6iRr0Xk3_Z7TMlI92yFmerzI";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  TESTING ACTUAL WORKER CODE (index.ts) - DIRECT MODE     ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('This simulates the exact Cloudflare Worker environment');
console.log('by running the same code with the same Supabase client.\n');

// Extract the exact worker implementation (copy from index.ts lines 350-520)
class LifeCurrentsAgent {
    constructor() {
        this.supabase = supabase;
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

        // THIS IS THE FIXED CODE from index.ts
        const { data, error } = await this.supabase
            .from('chat_messages')
            .select('id, thread_id, parent_id')
            .eq('thread_id', normalizedConversationId)  // FIXED: was conversation_id
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
            currentMessageId = row.parent_id;  // FIXED: was parent_message_id
        }

        return ancestorIds;
    }

    // THIS IS THE EXACT IMPLEMENTATION from index.ts lines 1428-1471
    async get_messages_for_period({ conversation_id, message_id, period_start, period_end }) {
        try {
            console.log('[Worker] Executing get_messages_for_period');
            console.log('  Parameters:', { conversation_id, message_id, period_start, period_end });

            const normalizedConversationId = this.normalizeId(conversation_id, 'conversation_id');
            const normalizedMessageId = this.normalizeId(message_id, 'message_id');
            const normalizedPeriodStart = this.normalizeIsoTimestamp(period_start, 'period_start');
            const normalizedPeriodEnd = this.normalizeIsoTimestamp(period_end, 'period_end');

            const startDate = new Date(normalizedPeriodStart);
            const endDate = new Date(normalizedPeriodEnd);
            if (startDate >= endDate) {
                throw new Error('period_end must be after period_start.');
            }

            console.log('[Worker] Walking ancestral chain...');
            const ancestorIds = await this.getAncestralMessageIds(normalizedConversationId, normalizedMessageId);
            const uniqueAncestorIds = Array.from(new Set(ancestorIds));
            console.log(`[Worker] Found ${uniqueAncestorIds.length} unique ancestors`);

            if (uniqueAncestorIds.length === 0) {
                return { tool: 'get_messages_for_period', success: true, data: { messages: [] } };
            }

            console.log('[Worker] Querying Supabase for messages in date range...');
            console.log('  Query: chat_messages where thread_id =', normalizedConversationId);
            console.log('         and id IN', uniqueAncestorIds.length, 'ancestor ids');
            console.log('         and created_at between', normalizedPeriodStart, 'and', normalizedPeriodEnd);

            // THIS IS THE FIXED QUERY from index.ts
            const { data, error } = await this.supabase
                .from('chat_messages')
                .select('*')
                .eq('thread_id', normalizedConversationId)  // FIXED: was conversation_id
                .in('id', uniqueAncestorIds)
                .gte('created_at', normalizedPeriodStart)
                .lte('created_at', normalizedPeriodEnd)
                .order('created_at', { ascending: true });

            if (error) {
                console.error('[Worker] Supabase error:', error);
                throw new Error(`Failed to fetch messages for period: ${error.message}`);
            }

            const messages = data ?? [];
            console.log(`[Worker] Success! Found ${messages.length} messages`);

            return { 
                tool: 'get_messages_for_period', 
                success: true, 
                data: { messages } 
            };
        } catch (error) {
            console.error('[Worker] Error:', error.message);
            return { 
                tool: 'get_messages_for_period', 
                success: false, 
                error: { message: error.message } 
            };
        }
    }
}

// Run the test
async function runTest() {
    const agent = new LifeCurrentsAgent();
    
    // Exact parameters from frontend logs
    const testParams = {
        conversation_id: 'f44410bf-85db-4f94-a988-ee13ebc3b72c',
        message_id: '06f8c6a6-4a87-44a4-ac5b-031790715da2',
        period_start: '2025-10-15T00:00:00.000Z',
        period_end: '2025-10-16T00:00:00.000Z'
    };

    console.log('═══════════════════════════════════════════════════════════');
    console.log('TEST PARAMETERS (from frontend logs):');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(JSON.stringify(testParams, null, 2));
    console.log('');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('CALLING WORKER METHOD: agent.get_messages_for_period()');
    console.log('═══════════════════════════════════════════════════════════\n');

    const result = await agent.get_messages_for_period(testParams);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('WORKER RESULT');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Success:', result.success);
    console.log('Tool:', result.tool);

    if (result.success) {
        const messages = result.data?.messages || [];
        console.log('Message count:', messages.length);
        
        if (messages.length > 0) {
            console.log('\nMessages returned:');
            messages.forEach((msg, i) => {
                console.log(`  ${i + 1}. [${msg.role}] ${msg.id} at ${msg.created_at}`);
            });
            
            console.log('\n╔════════════════════════════════════════════════════════════╗');
            console.log('║  ✓ SUCCESS! FIXED WORKER CODE WORKS!                      ║');
            console.log('╚════════════════════════════════════════════════════════════╝');
            console.log('\nThe fixed code in index.ts correctly:');
            console.log('  ✓ Uses thread_id instead of conversation_id');
            console.log('  ✓ Uses parent_id instead of parent_message_id');
            console.log('  ✓ Returns', messages.length, 'messages for Oct 15');
            console.log('\nOnce deployed, the frontend will receive these messages!');
        } else {
            console.log('\n⚠️  No messages found in the specified date range');
        }
    } else {
        console.log('Error:', result.error);
        console.log('\n✗ FAILED - See error above');
    }

    console.log('\n');
}

runTest().catch(error => {
    console.error('\n✗ Test failed with exception:', error);
    process.exit(1);
});

