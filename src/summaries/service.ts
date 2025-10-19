import type { SupabaseClient } from "@supabase/supabase-js";
import { TimeHelper, ensureChronological, estimateTokenCount, safeISO, summaryKey } from "./time";

export type SummaryLevel = "DAY" | "WEEK" | "MONTH";

export interface ConversationMessageRecord {
    id: string;
    conversation_id: string;
    role: string;
    content: unknown;
    created_at: string;
    parent_message_id?: string | null;
    metadata?: Record<string, unknown> | null;
}

export interface ConversationSummaryRecord {
    id: string;
    conversation_id: string;
    level: SummaryLevel;
    period_start: string;
    content: string;
    created_by_message_id: string | null;
    created_at?: string;
    updated_at?: string;
}

type SummaryEvent =
    | { type: "summary_started"; conversation_id: string; level: SummaryLevel; period_start: string; period_end: string; human_label: string }
    | { type: "summary_completed"; conversation_id: string; level: SummaryLevel; period_start: string; period_end: string; human_label: string; summary_id: string }
    | { type: "summary_reused"; conversation_id: string; level: SummaryLevel; period_start: string; period_end: string; human_label: string; summary_id: string }
    | { type: "summary_skipped"; conversation_id: string; level: SummaryLevel; period_start: string; period_end: string; human_label: string; reason: string }
    | { type: "context_composed"; conversation_id: string; estimated_tokens: { system_summaries: number; raw: number; total: number } };

type EmitEvent = (event: SummaryEvent) => void;

const DEFAULT_SUMMARIZATION_PROMPT = `You are LifeCurrents' hierarchical summarization assistant. Carefully read the provided content for the requested period and produce a concise, factual summary that captures objectives, progress, blockers, and any explicit next steps. Use short paragraphs or bullet points where appropriate. Do not invent details or speculate—only summarize what is explicitly present. The tone should remain neutral and informative.`;

interface RequirementBase {
    level: SummaryLevel;
    periodStart: Date;
    periodEnd: Date;
    label: string;
    humanLabel: string;
}

interface DayRequirement extends RequirementBase {
    level: "DAY";
    dayKey: string;
    messages: ConversationMessageRecord[];
}

interface WeekRequirement extends RequirementBase {
    level: "WEEK";
    dayKeys: string[];
}

interface MonthRequirement extends RequirementBase {
    level: "MONTH";
    dayKeys: string[];
}

type SummaryRequirement = DayRequirement | WeekRequirement | MonthRequirement;

interface RequirementSet {
    days: DayRequirement[];
    weeks: WeekRequirement[];
    months: MonthRequirement[];
    ordered: SummaryRequirement[];
    yesterday?: DayRequirement;
}

interface ConversationContext {
    conversationId: string;
    currentMessage: ConversationMessageRecord;
    timezone: string;
    helper: TimeHelper;
    todayStart: Date;
    todayEnd: Date;
    yesterdayStart: Date;
    currentWeekStart: Date;
    currentMonthStart: Date;
    ancestryIds: Set<string>;
    allMessages: ConversationMessageRecord[];
    rawToday: ConversationMessageRecord[];
    rawTail: ConversationMessageRecord[];
    requirements: RequirementSet;
}

const normalizeContent = (content: unknown): string => {
    if (content === null || content === undefined) {
        return "";
    }
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map(item => {
                if (typeof item === "string") {
                    return item;
                }
                if (item && typeof item === "object") {
                    if (typeof (item as any).text === "string") {
                        return (item as any).text;
                    }
                    if (typeof (item as any).content === "string") {
                        return (item as any).content;
                    }
                    return JSON.stringify(item);
                }
                return String(item);
            })
            .join("\n");
    }
    if (typeof content === "object") {
        if (content && typeof (content as any).text === "string") {
            return (content as any).text;
        }
        if (content && typeof (content as any).content === "string") {
            return (content as any).content;
        }
        return JSON.stringify(content);
    }
    return String(content);
};

const truncate = (value: string, length = 180): string => {
    if (value.length <= length) {
        return value;
    }
    return `${value.slice(0, length - 1)}…`;
};

const buildEmptySummaryBody = (requirement: SummaryRequirement): string => {
    switch (requirement.level) {
        case "DAY":
            return "No messages were recorded for this day.";
        case "WEEK":
            return "No day-level summaries were available for this week.";
        case "MONTH":
            return "No day-level summaries were available for this month.";
    }
};

const DEFAULT_TAIL_LIMIT = 6;

export class SummaryCoordinator {
    private readonly supabase: SupabaseClient;
    private readonly emitEvent: EmitEvent;

    constructor(supabase: SupabaseClient, emitEvent: EmitEvent) {
        this.supabase = supabase;
        this.emitEvent = emitEvent;
    }

    private async resolveTimezone(conversationId: string, explicit?: string | null): Promise<string> {
        if (explicit && explicit.trim().length > 0) {
            return explicit.trim();
        }

        try {
            const { data, error } = await this.supabase
                .from("conversation_settings")
                .select("timezone")
                .eq("conversation_id", conversationId)
                .maybeSingle();
            if (error) {
                console.warn("Failed to resolve timezone via conversation_settings", error);
            } else if (data?.timezone) {
                return data.timezone;
            }
        } catch (error) {
            console.warn("Error resolving timezone from conversation_settings", error);
        }

        try {
            const { data, error } = await this.supabase
                .from("conversations")
                .select("timezone")
                .eq("id", conversationId)
                .maybeSingle();
            if (error) {
                console.warn("Failed to resolve timezone via conversations", error);
            } else if (data?.timezone) {
                return data.timezone;
            }
        } catch (error) {
            console.warn("Error resolving timezone from conversations", error);
        }

        return "UTC";
    }

    private async fetchMessageAncestry(conversationId: string, messageId: string): Promise<ConversationMessageRecord[]> {
        const chain: ConversationMessageRecord[] = [];
        let currentId: string | null = messageId;
        const guard = new Set<string>();

        while (currentId) {
            if (guard.has(currentId)) {
                throw new Error("Detected cyclical message ancestry; aborting");
            }
            guard.add(currentId);

            const result = await this.supabase
                .from("conversation_messages")
                .select("id, conversation_id, role, content, created_at, parent_message_id, metadata")
                .eq("id", currentId)
                .maybeSingle();

            if (result.error) {
                throw new Error(`Failed to load message ${currentId}: ${result.error.message}`);
            }

            const data = result.data as ConversationMessageRecord | null;

            if (!data) {
                throw new Error(`Message ${currentId} not found.`);
            }

            if (data.conversation_id !== conversationId) {
                throw new Error(`Message ${currentId} does not belong to conversation ${conversationId}.`);
            }

            chain.push(data as ConversationMessageRecord);
            currentId = (data as any).parent_message_id ?? null;
        }

        return ensureChronological(chain);
    }

    private groupMessagesByDay(messages: ConversationMessageRecord[], helper: TimeHelper): Map<string, ConversationMessageRecord[]> {
        const dayMap = new Map<string, ConversationMessageRecord[]>();
        for (const message of messages) {
            const createdAt = new Date(message.created_at);
            const dayStart = helper.startOfDay(createdAt);
            const key = safeISO(dayStart);
            if (!dayMap.has(key)) {
                dayMap.set(key, []);
            }
            dayMap.get(key)!.push(message);
        }
        return dayMap;
    }

    private buildRequirements(
        helper: TimeHelper,
        dayMap: Map<string, ConversationMessageRecord[]>,
        todayStart: Date,
        yesterdayStart: Date,
        currentWeekStart: Date,
        currentMonthStart: Date,
    ): RequirementSet {
        const days: DayRequirement[] = [];
        const weeks: WeekRequirement[] = [];
        const months: MonthRequirement[] = [];

        let yesterdayRequirement: DayRequirement | undefined;

        const sortedDayKeys = [...dayMap.keys()].sort();
        for (const key of sortedDayKeys) {
            const dayStart = new Date(key);
            if (dayStart.getTime() >= todayStart.getTime()) {
                continue;
            }
            const messages = ensureChronological(dayMap.get(key) ?? []);
            const label = helper.getHumanDayLabel(dayStart, todayStart, yesterdayStart);
            const requirement: DayRequirement = {
                level: "DAY",
                periodStart: dayStart,
                periodEnd: helper.addDays(dayStart, 1),
                dayKey: key,
                label,
                humanLabel: label,
                messages,
            };
            if (dayStart.getTime() === yesterdayStart.getTime()) {
                yesterdayRequirement = requirement;
            } else if (dayStart.getTime() >= currentWeekStart.getTime()) {
                days.push(requirement);
            }
        }

        const weekDayKeys = new Map<string, string[]>();
        for (const key of sortedDayKeys) {
            const dayStart = new Date(key);
            if (dayStart.getTime() >= todayStart.getTime()) {
                continue;
            }
            const weekStart = helper.startOfWeek(dayStart);
            const weekKey = safeISO(weekStart);
            if (!weekDayKeys.has(weekKey)) {
                weekDayKeys.set(weekKey, []);
            }
            weekDayKeys.get(weekKey)!.push(key);
        }

        for (const [weekKey, dayKeys] of weekDayKeys.entries()) {
            const weekStart = new Date(weekKey);
            if (weekStart.getTime() >= currentWeekStart.getTime()) {
                continue;
            }
            if (weekStart.getTime() < currentMonthStart.getTime()) {
                continue;
            }
            const label = helper.getHumanWeekLabel(weekStart, currentWeekStart);
            weeks.push({
                level: "WEEK",
                periodStart: weekStart,
                periodEnd: helper.addDays(weekStart, 7),
                dayKeys: dayKeys.sort(),
                label,
                humanLabel: label,
            });
        }

        const monthDayKeys = new Map<string, string[]>();
        for (const key of sortedDayKeys) {
            const dayStart = new Date(key);
            if (dayStart.getTime() >= todayStart.getTime()) {
                continue;
            }
            const monthStart = helper.startOfMonth(dayStart);
            const monthKey = safeISO(monthStart);
            if (!monthDayKeys.has(monthKey)) {
                monthDayKeys.set(monthKey, []);
            }
            monthDayKeys.get(monthKey)!.push(key);
        }

        for (const [monthKey, dayKeys] of monthDayKeys.entries()) {
            const monthStart = new Date(monthKey);
            if (monthStart.getTime() >= currentMonthStart.getTime()) {
                continue;
            }
            const label = helper.getHumanMonthLabel(monthStart, currentMonthStart);
            months.push({
                level: "MONTH",
                periodStart: monthStart,
                periodEnd: helper.startOfNextMonth(monthStart),
                dayKeys: dayKeys.sort(),
                label,
                humanLabel: label,
            });
        }

        const ordered: SummaryRequirement[] = [
            ...months.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime()),
            ...weeks.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime()),
            ...days.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime()),
        ];
        if (yesterdayRequirement) {
            ordered.push(yesterdayRequirement);
        }

        return {
            days,
            weeks,
            months,
            ordered,
            yesterday: yesterdayRequirement,
        };
    }

    private buildContext(
        conversationId: string,
        timezone: string,
        messages: ConversationMessageRecord[],
    ): ConversationContext {
        if (messages.length === 0) {
            throw new Error("Conversation branch has no messages; cannot compose context.");
        }

        const helper = new TimeHelper(timezone);
        const currentMessage = messages[messages.length - 1];
        const referenceDate = new Date(currentMessage.created_at ?? Date.now());
        const todayStart = helper.startOfDay(referenceDate);
        const todayEnd = helper.addDays(todayStart, 1);
        const yesterdayStart = helper.addDays(todayStart, -1);
        const currentWeekStart = helper.startOfWeek(todayStart);
        const currentMonthStart = helper.startOfMonth(todayStart);

        const ancestryIds = new Set(messages.map(message => message.id));
        const allMessages = ensureChronological(messages);
        const dayMap = this.groupMessagesByDay(allMessages, helper);

        if (!dayMap.has(safeISO(yesterdayStart))) {
            dayMap.set(safeISO(yesterdayStart), []);
        }

        const requirements = this.buildRequirements(helper, dayMap, todayStart, yesterdayStart, currentWeekStart, currentMonthStart);

        const rawToday = allMessages.filter(message => {
            const createdAt = Date.parse(message.created_at);
            return createdAt >= todayStart.getTime() && createdAt < todayEnd.getTime();
        });

        const preToday = allMessages.filter(message => Date.parse(message.created_at) < todayStart.getTime());
        const rawTail = preToday.slice(Math.max(0, preToday.length - DEFAULT_TAIL_LIMIT));

        return {
            conversationId,
            timezone,
            helper,
            currentMessage,
            todayStart,
            todayEnd,
            yesterdayStart,
            currentWeekStart,
            currentMonthStart,
            ancestryIds,
            allMessages,
            rawToday,
            rawTail,
            requirements,
        };
    }

    private async loadExistingSummaries(conversationId: string): Promise<Map<string, ConversationSummaryRecord>> {
        const summaryMap = new Map<string, ConversationSummaryRecord>();
        const queryResult = await this.supabase
            .from("conversation_summaries")
            .select("id, conversation_id, level, period_start, content, created_by_message_id, created_at, updated_at")
            .eq("conversation_id", conversationId);

        if (queryResult.error) {
            throw new Error(`Failed to load summaries: ${queryResult.error.message}`);
        }

        const rows = (queryResult.data ?? []) as ConversationSummaryRecord[];

        for (const entry of rows) {
            const normalized = entry as ConversationSummaryRecord;
            if (!normalized.level || !normalized.period_start) {
                continue;
            }
            const key = summaryKey(normalized.level, normalized.period_start);
            summaryMap.set(key, normalized);
        }

        return summaryMap;
    }

    private ensureSummaryRecord(
        summaryMap: Map<string, ConversationSummaryRecord>,
        record: ConversationSummaryRecord,
    ) {
        const key = summaryKey(record.level, record.period_start);
        summaryMap.set(key, record);
    }

    private async upsertSummary(record: {
        conversation_id: string;
        level: SummaryLevel;
        period_start: string;
        content: string;
        created_by_message_id: string;
    }): Promise<ConversationSummaryRecord> {
        const result = await this.supabase
            .from("conversation_summaries")
            .upsert(record, { onConflict: "conversation_id,level,period_start" })
            .select("id, conversation_id, level, period_start, content, created_by_message_id, created_at, updated_at")
            .maybeSingle();

        if (result.error) {
            throw new Error(`Failed to upsert summary for ${record.level} at ${record.period_start}: ${result.error.message}`);
        }

        if (!result.data) {
            throw new Error("Upsert did not return a summary record");
        }

        return result.data as ConversationSummaryRecord;
    }

    private buildDaySummaryBody(requirement: DayRequirement): string {
        const lines = requirement.messages.map(message => {
            const timestamp = new Date(message.created_at).toISOString();
            const text = truncate(normalizeContent(message.content));
            return `• [${timestamp}] ${message.role.toUpperCase()}: ${text}`;
        });

        if (lines.length === 0) {
            return buildEmptySummaryBody(requirement);
        }

        return lines.join("\n");
    }

    private buildAggregateSummaryBody(requirement: WeekRequirement | MonthRequirement, daySummaries: ConversationSummaryRecord[]): string {
        if (daySummaries.length === 0) {
            return buildEmptySummaryBody(requirement);
        }

        const bulletPoints = daySummaries
            .sort((a, b) => Date.parse(a.period_start) - Date.parse(b.period_start))
            .map(summary => {
                const headline = summary.content.split("\n").filter(Boolean)[0] ?? "Day Summary";
                return `• ${headline}`;
            });

        return bulletPoints.join("\n");
    }

    private evaluateExisting(
        summaryMap: Map<string, ConversationSummaryRecord>,
        requirement: SummaryRequirement,
        ancestryIds: Set<string>,
    ): { status: "missing" | "invalid" | "exists"; summary?: ConversationSummaryRecord } {
        const key = summaryKey(requirement.level, safeISO(requirement.periodStart));
        const summary = summaryMap.get(key);
        if (!summary) {
            return { status: "missing" };
        }
        if (!summary.created_by_message_id || !ancestryIds.has(summary.created_by_message_id)) {
            return { status: "invalid", summary };
        }
        return { status: "exists", summary };
    }

    private toRequirementRecord(requirement: SummaryRequirement): { level: SummaryLevel; period_start: string; period_end: string; label: string } {
        return {
            level: requirement.level,
            period_start: safeISO(requirement.periodStart),
            period_end: safeISO(requirement.periodEnd),
            label: requirement.humanLabel,
        };
    }

    async listRequired(params: { conversationId: string; currentMessageId: string; timezone?: string }): Promise<{ required: Array<{ level: SummaryLevel; period_start: string; period_end: string; status: "exists" | "missing" | "invalid"; human_label: string; candidate_summary_id?: string }> }> {
        const timezone = await this.resolveTimezone(params.conversationId, params.timezone);
        const ancestry = await this.fetchMessageAncestry(params.conversationId, params.currentMessageId);
        const context = this.buildContext(params.conversationId, timezone, ancestry);
        const summaryMap = await this.loadExistingSummaries(params.conversationId);

        const required = context.requirements.ordered.map(requirement => {
            const { status, summary } = this.evaluateExisting(summaryMap, requirement, context.ancestryIds);
            return {
                level: requirement.level,
                period_start: safeISO(requirement.periodStart),
                period_end: safeISO(requirement.periodEnd),
                status,
                human_label: requirement.humanLabel,
                candidate_summary_id: summary?.id,
            };
        });

        return { required };
    }

    private emitSummaryStarted(requirement: SummaryRequirement, conversationId: string) {
        this.emitEvent({
            type: "summary_started",
            conversation_id: conversationId,
            level: requirement.level,
            period_start: safeISO(requirement.periodStart),
            period_end: safeISO(requirement.periodEnd),
            human_label: requirement.humanLabel,
        });
    }

    private emitSummaryCompleted(requirement: SummaryRequirement, conversationId: string, summaryId: string) {
        this.emitEvent({
            type: "summary_completed",
            conversation_id: conversationId,
            level: requirement.level,
            period_start: safeISO(requirement.periodStart),
            period_end: safeISO(requirement.periodEnd),
            human_label: requirement.humanLabel,
            summary_id: summaryId,
        });
    }

    private emitSummaryReused(requirement: SummaryRequirement, conversationId: string, summaryId: string) {
        this.emitEvent({
            type: "summary_reused",
            conversation_id: conversationId,
            level: requirement.level,
            period_start: safeISO(requirement.periodStart),
            period_end: safeISO(requirement.periodEnd),
            human_label: requirement.humanLabel,
            summary_id: summaryId,
        });
    }

    private emitSummarySkipped(requirement: SummaryRequirement, conversationId: string, reason: string) {
        this.emitEvent({
            type: "summary_skipped",
            conversation_id: conversationId,
            level: requirement.level,
            period_start: safeISO(requirement.periodStart),
            period_end: safeISO(requirement.periodEnd),
            human_label: requirement.humanLabel,
            reason,
        });
    }

    private async generateForRequirement(
        requirement: SummaryRequirement,
        context: ConversationContext,
        summaryMap: Map<string, ConversationSummaryRecord>,
        summarizationPrompt: string,
        generationLog: {
            generated: Array<{ level: SummaryLevel; period_start: string; period_end: string; created_by_message_id: string }>;
            reused: Array<{ level: SummaryLevel; period_start: string; period_end: string; created_by_message_id: string }>;
            skipped: Array<{ level: SummaryLevel; period_start: string; period_end: string; reason: string }>;
        },
    ): Promise<ConversationSummaryRecord | null> {
        this.emitSummaryStarted(requirement, context.conversationId);
        const evaluation = this.evaluateExisting(summaryMap, requirement, context.ancestryIds);
        if (evaluation.status === "exists" && evaluation.summary) {
            generationLog.reused.push({
                level: requirement.level,
                period_start: safeISO(requirement.periodStart),
                period_end: safeISO(requirement.periodEnd),
                created_by_message_id: evaluation.summary.created_by_message_id ?? "",
            });
            this.emitSummaryReused(requirement, context.conversationId, evaluation.summary.id);
            return evaluation.summary;
        }

        let body: string;
        if (requirement.level === "DAY") {
            body = this.buildDaySummaryBody(requirement);
        } else {
            const childSummaries: ConversationSummaryRecord[] = [];
            for (const dayKey of requirement.dayKeys) {
                const key = summaryKey("DAY", dayKey);
                const daySummary = summaryMap.get(key);
                if (daySummary) {
                    childSummaries.push(daySummary);
                }
            }
            body = this.buildAggregateSummaryBody(requirement, childSummaries);
        }

        const finalBody = body && body.trim().length > 0 ? body : buildEmptySummaryBody(requirement);
        const wantsBullets = /bullet/i.test(summarizationPrompt);
        const normalizedBody = wantsBullets
            ? finalBody
            : finalBody
                .split("\n")
                .map(line => line.replace(/^•\s*/u, "").trim())
                .filter(line => line.length > 0)
                .join("\n\n");
        const finalContent = `${requirement.label}\n\n${normalizedBody || buildEmptySummaryBody(requirement)}`.trim();

        const record = await this.upsertSummary({
            conversation_id: context.conversationId,
            level: requirement.level,
            period_start: safeISO(requirement.periodStart),
            content: finalContent,
            created_by_message_id: context.currentMessage.id,
        });

        this.ensureSummaryRecord(summaryMap, record);
        generationLog.generated.push({
            level: requirement.level,
            period_start: record.period_start,
            period_end: safeISO(requirement.periodEnd),
            created_by_message_id: context.currentMessage.id,
        });
        this.emitSummaryCompleted(requirement, context.conversationId, record.id);
        return record;
    }

    private collectSystemSummaries(
        context: ConversationContext,
        summaryMap: Map<string, ConversationSummaryRecord>,
    ) {
        const systemSummaries = [] as Array<{ level: SummaryLevel; label: string; period_start: string; period_end: string; content: string }>;
        const assemblyOrder: Array<{ type: "summary"; level: SummaryLevel; period_start: string; period_end: string }> = [];

        const pushRequirement = (requirement: SummaryRequirement) => {
            const key = summaryKey(requirement.level, safeISO(requirement.periodStart));
            const summary = summaryMap.get(key);
            if (!summary) {
                return;
            }
            systemSummaries.push({
                level: requirement.level,
                label: requirement.humanLabel,
                period_start: safeISO(requirement.periodStart),
                period_end: safeISO(requirement.periodEnd),
                content: summary.content,
            });
            assemblyOrder.push({
                type: "summary",
                level: requirement.level,
                period_start: safeISO(requirement.periodStart),
                period_end: safeISO(requirement.periodEnd),
            });
        };

        const months = context.requirements.months.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
        const weeks = context.requirements.weeks.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
        const days = context.requirements.days.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());

        for (const requirement of months) {
            pushRequirement(requirement);
        }
        for (const requirement of weeks) {
            pushRequirement(requirement);
        }
        for (const requirement of days) {
            pushRequirement(requirement);
        }
        if (context.requirements.yesterday) {
            pushRequirement(context.requirements.yesterday);
        }

        return { systemSummaries, assemblyOrder };
    }

    private buildComposedContext(
        context: ConversationContext,
        summaryMap: Map<string, ConversationSummaryRecord>,
    ) {
        const { systemSummaries, assemblyOrder } = this.collectSystemSummaries(context, summaryMap);

        const rawToday = ensureChronological(context.rawToday);
        const rawTail = ensureChronological(context.rawTail).filter(message => !rawToday.some(today => today.id === message.id));

        const systemTokens = systemSummaries.reduce((acc, summary) => acc + estimateTokenCount(summary.content), 0);
        const rawTokens = [...rawToday, ...rawTail].reduce((acc, message) => {
            const text = `${message.role.toUpperCase()}: ${normalizeContent(message.content)}`;
            return acc + estimateTokenCount(text);
        }, 0);
        const totalTokens = systemTokens + rawTokens;

        const policy = {
            boundaries: {
                day: "midnight",
                week: "sunday_midnight",
                month: "calendar_month_end_midnight",
                timezone: context.helper.getTimeZone(),
            },
            inclusion: {
                include_yesterday_summary: true,
                include_all_today_raw: true,
                include_tail_last_6: true,
            },
        };

        const composed_context = {
            system_summaries: systemSummaries,
            raw_messages_today: rawToday,
            raw_tail_across_boundary: rawTail,
            assembly_order: [
                ...assemblyOrder,
                { type: "raw", segment: "today" as const },
                { type: "raw", segment: "tail" as const },
            ],
            token_estimates: {
                system_summaries_tokens: systemTokens,
                raw_tokens: rawTokens,
                total_tokens: totalTokens,
            },
        };

        return { composed_context, policy, tokenEstimates: { systemTokens, rawTokens, totalTokens } };
    }

    async composeContext(params: {
        conversationId: string;
        currentMessageId: string;
        mode: string;
        timezone?: string;
        summarizationPrompt?: string;
    }) {
        if (params.mode !== "intelligent") {
            throw new Error(`Unsupported mode '${params.mode}'. Only 'intelligent' is currently supported.`);
        }

        const timezone = await this.resolveTimezone(params.conversationId, params.timezone);
        const ancestry = await this.fetchMessageAncestry(params.conversationId, params.currentMessageId);
        const context = this.buildContext(params.conversationId, timezone, ancestry);
        const summaryMap = await this.loadExistingSummaries(params.conversationId);
        const prompt = params.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;

        const generation = {
            generated: [] as Array<{ level: SummaryLevel; period_start: string; period_end: string; created_by_message_id: string }>,
            reused: [] as Array<{ level: SummaryLevel; period_start: string; period_end: string; created_by_message_id: string }>,
            skipped: [] as Array<{ level: SummaryLevel; period_start: string; period_end: string; reason: string }>,
        };

        for (const requirement of context.requirements.ordered) {
            try {
                await this.generateForRequirement(requirement, context, summaryMap, prompt, generation);
            } catch (error: any) {
                this.emitSummarySkipped(requirement, context.conversationId, error?.message ?? "Unknown summarization error");
                generation.skipped.push({
                    level: requirement.level,
                    period_start: safeISO(requirement.periodStart),
                    period_end: safeISO(requirement.periodEnd),
                    reason: error?.message ?? "Unknown summarization error",
                });
                throw error;
            }
        }

        const { composed_context, policy, tokenEstimates } = this.buildComposedContext(context, summaryMap);

        this.emitEvent({
            type: "context_composed",
            conversation_id: params.conversationId,
            estimated_tokens: {
                system_summaries: tokenEstimates.systemTokens,
                raw: tokenEstimates.rawTokens,
                total: tokenEstimates.totalTokens,
            },
        });

        return {
            composed_context,
            generation,
            policy,
        };
    }

    async generate(params: {
        conversationId: string;
        currentMessageId: string;
        level: SummaryLevel;
        periodStart: string;
        timezone?: string;
        summarizationPrompt?: string;
    }) {
        const timezone = await this.resolveTimezone(params.conversationId, params.timezone);
        const ancestry = await this.fetchMessageAncestry(params.conversationId, params.currentMessageId);
        const context = this.buildContext(params.conversationId, timezone, ancestry);
        const summaryMap = await this.loadExistingSummaries(params.conversationId);
        const targetStart = new Date(params.periodStart);

        const requirement = context.requirements.ordered.find(candidate => candidate.level === params.level && candidate.periodStart.getTime() === targetStart.getTime());
        if (!requirement) {
            throw new Error(`Requested summary period ${params.periodStart} (${params.level}) is not part of the current conversation context.`);
        }

        const generation = {
            generated: [] as Array<{ level: SummaryLevel; period_start: string; period_end: string; created_by_message_id: string }>,
            reused: [] as Array<{ level: SummaryLevel; period_start: string; period_end: string; created_by_message_id: string }>,
            skipped: [] as Array<{ level: SummaryLevel; period_start: string; period_end: string; reason: string }>,
        };

        const summary = await this.generateForRequirement(requirement, context, summaryMap, params.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT, generation);

        return {
            summary,
            generation,
        };
    }

    async getSummaries(params: {
        conversationId: string;
        levels?: SummaryLevel[];
        start?: string;
        end?: string;
    }) {
        let query = this.supabase
            .from("conversation_summaries")
            .select("id, conversation_id, level, period_start, content, created_by_message_id, created_at, updated_at")
            .eq("conversation_id", params.conversationId)
            .order("period_start", { ascending: true });

        if (params.levels && params.levels.length > 0) {
            query = query.in("level", params.levels);
        }
        if (params.start) {
            query = query.gte("period_start", params.start);
        }
        if (params.end) {
            query = query.lt("period_start", params.end);
        }

        const result = await query;

        if (result.error) {
            throw new Error(`Failed to fetch summaries: ${result.error.message}`);
        }

        return (result.data ?? []) as ConversationSummaryRecord[];
    }
}

