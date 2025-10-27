// Intelligent Hierarchical Context Summarization service for the LifeCurrents worker.
import { SupabaseClient } from '@supabase/supabase-js';

export type SummaryLevel = 'DAY' | 'WEEK' | 'MONTH';

export interface ConversationMessage {
    id: string;
    conversation_id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | Record<string, unknown> | null;
    created_at: string;
    parent_message_id?: string | null;
}

export interface ConversationSummary {
    id: string;
    conversation_id: string;
    level: SummaryLevel;
    period_start: string;
    period_end: string | null;
    content: string;
    created_by_message_id: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface SummaryEventEmitter {
    (event: string, payload: Record<string, unknown>): void;
}

export interface ComposeContextForTurnInput {
    conversationId: string;
    currentMessageId: string;
    mode: 'intelligent';
    summarizationPrompt?: string;
    timezone?: string;
}

export interface ComposeContextForTurnResult {
    composed_context: {
        system_summaries: Array<{
            level: SummaryLevel;
            label: string;
            period_start: string;
            period_end: string;
            content: string;
        }>;
        raw_messages_today: ConversationMessage[];
        raw_tail_across_boundary: ConversationMessage[];
        assembly_order: string[];
        token_estimates: {
            system_summaries_tokens: number;
            raw_tokens: number;
            total_tokens: number;
        };
    };
    generation: {
        generated: Array<{ level: SummaryLevel; period_start: string; created_by_message_id: string | null }>;
        reused: Array<{ level: SummaryLevel; period_start: string; created_by_message_id: string | null }>;
        skipped: Array<{ level: SummaryLevel; period_start: string; reason: string }>;
    };
    policy: {
        boundaries: {
            day: string;
            week: string;
            month: string;
            timezone: string;
        };
        inclusion: {
            include_yesterday_summary: boolean;
            include_all_today_raw: boolean;
            include_tail_last_6: boolean;
        };
    };
}

export interface ListRequiredSummariesInput {
    conversationId: string;
    currentMessageId: string;
    timezone?: string;
}

export interface ListRequiredSummaryEntry {
    level: SummaryLevel;
    period_start: string;
    status: 'exists' | 'missing' | 'invalid';
    candidate_summary_id?: string;
}

export interface GetSummariesInput {
    conversationId: string;
    levels?: SummaryLevel[];
    start?: string;
    end?: string;
}

export interface GenerateSummaryInput {
    conversationId: string;
    level: SummaryLevel;
    periodStart: string;
    currentMessageId: string;
    summarizationPrompt?: string;
    timezone?: string;
}

const DEFAULT_TIMEZONE = 'UTC';

const DEFAULT_SUMMARIZATION_PROMPT = `You are the LifeCurrents summarization agent. Produce concise, factual summaries that capture progress, blockers, and next actions. Avoid embellishment or speculation.`;

interface DateParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();
const dateLabelFormatters = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = dateTimeFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            calendar: 'iso8601',
            numberingSystem: 'latn',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
        dateTimeFormatters.set(timeZone, formatter);
    }
    return formatter;
}

function getWeekdayFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = weekdayFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'short',
        });
        weekdayFormatters.set(timeZone, formatter);
    }
    return formatter;
}

function getDateLabelFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = dateLabelFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
        dateLabelFormatters.set(timeZone, formatter);
    }
    return formatter;
}

function getDateParts(date: Date, timeZone: string): DateParts {
    const formatter = getDateTimeFormatter(timeZone);
    const parts = formatter.formatToParts(date);
    const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of parts) {
        map[part.type] = part.value;
    }
    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    const second = Number(map.second);
    const millisecond = date.getUTCMilliseconds();
    return { year, month, day, hour, minute, second, millisecond };
}

function makeDateFromParts(parts: Partial<DateParts> & { year: number; month: number; day: number }, timeZone: string): Date {
    const hour = parts.hour ?? 0;
    const minute = parts.minute ?? 0;
    const second = parts.second ?? 0;
    const millisecond = parts.millisecond ?? 0;

    const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, second, millisecond);
    const guessDate = new Date(utcGuess);
    const formatter = getDateTimeFormatter(timeZone);
    const guessParts = formatter.formatToParts(guessDate);
    const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of guessParts) {
        map[part.type] = part.value;
    }
    const correctedUTC = Date.UTC(
        Number(map.year),
        Number(map.month) - 1,
        Number(map.day),
        Number(map.hour),
        Number(map.minute),
        Number(map.second),
        millisecond,
    );
    const diff = correctedUTC - utcGuess;
    return new Date(utcGuess - diff);
}

function addDays(date: Date, days: number, timeZone: string): Date {
    const parts = getDateParts(date, timeZone);
    const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond));
    base.setUTCDate(base.getUTCDate() + days);
    return makeDateFromParts(
        {
            year: base.getUTCFullYear(),
            month: base.getUTCMonth() + 1,
            day: base.getUTCDate(),
            hour: parts.hour,
            minute: parts.minute,
            second: parts.second,
            millisecond: parts.millisecond,
        },
        timeZone,
    );
}

function addMonths(date: Date, months: number, timeZone: string): Date {
    const parts = getDateParts(date, timeZone);
    const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond));
    base.setUTCMonth(base.getUTCMonth() + months);
    return makeDateFromParts(
        {
            year: base.getUTCFullYear(),
            month: base.getUTCMonth() + 1,
            day: base.getUTCDate(),
            hour: parts.hour,
            minute: parts.minute,
            second: parts.second,
            millisecond: parts.millisecond,
        },
        timeZone,
    );
}

function startOfDay(date: Date, timeZone: string): Date {
    const parts = getDateParts(date, timeZone);
    return makeDateFromParts({ year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone);
}

function startOfWeek(date: Date, timeZone: string): Date {
    const dayStart = startOfDay(date, timeZone);
    const weekdayFormatter = getWeekdayFormatter(timeZone);
    const weekdayString = weekdayFormatter.format(dayStart);
    const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const index = order.indexOf(weekdayString);
    const normalized = index >= 0 ? index : 0;
    if (normalized === 0) {
        return dayStart;
    }
    return addDays(dayStart, -normalized, timeZone);
}

function startOfMonth(date: Date, timeZone: string): Date {
    const parts = getDateParts(date, timeZone);
    return makeDateFromParts({ year: parts.year, month: parts.month, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone);
}

function iso(date: Date): string {
    return date.toISOString();
}

function compareAsc(a: Date, b: Date): number {
    return a.getTime() - b.getTime();
}

function truncateContent(content: string, maxLength = 280): string {
    if (content.length <= maxLength) {
        return content;
    }
    return `${content.slice(0, maxLength - 1)}…`;
}

function normalizeTimezone(timezone?: string | null): string {
    if (!timezone) {
        return DEFAULT_TIMEZONE;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
        return timezone;
    } catch (error) {
        console.warn(`Invalid timezone '${timezone}', defaulting to ${DEFAULT_TIMEZONE}`);
        return DEFAULT_TIMEZONE;
    }
}

function extractStringContent(content: ConversationMessage['content']): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!content) {
        return '';
    }
    try {
        return JSON.stringify(content);
    } catch (error) {
        return String(content);
    }
}

function estimateTokensFromText(text: string): number {
    if (!text) {
        return 0;
    }
    const normalized = text.trim();
    if (normalized.length === 0) {
        return 0;
    }
    return Math.max(1, Math.ceil(normalized.length / 4));
}

function estimateTokensForMessages(messages: ConversationMessage[]): number {
    let total = 0;
    for (const message of messages) {
        total += estimateTokensFromText(extractStringContent(message.content));
    }
    return total;
}

interface PeriodDescriptor {
    level: SummaryLevel;
    start: Date;
    end: Date;
    label: string;
    humanLabel: string;
}

interface ConversationContext {
    timezone: string;
    currentMessage: ConversationMessage;
    messages: ConversationMessage[];
    ancestrySet: Set<string>;
    branchMessages: ConversationMessage[];
    branchMessagesSorted: ConversationMessage[];
    messagesByDay: Map<string, ConversationMessage[]>;
    todayStart: Date;
    todayEnd: Date;
    yesterdayStart: Date;
    currentWeekStart: Date;
    currentMonthStart: Date;
}

interface SummaryCache {
    byKey: Map<string, ConversationSummary[]>;
}

function summaryCacheKey(level: SummaryLevel, periodStartIso: string): string {
    return `${level}:${periodStartIso}`;
}

function parseISODate(value: string): Date {
    return new Date(value);
}

function groupMessagesByDay(messages: ConversationMessage[], timeZone: string): Map<string, ConversationMessage[]> {
    const map = new Map<string, ConversationMessage[]>();
    for (const message of messages) {
        const date = new Date(message.created_at);
        const dayStart = startOfDay(date, timeZone);
        const key = iso(dayStart);
        if (!map.has(key)) {
            map.set(key, []);
        }
        map.get(key)!.push(message);
    }
    for (const group of map.values()) {
        group.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }
    return map;
}

function formatDayLabel(start: Date, timezone: string, todayStart: Date, yesterdayStart: Date): string {
    const formatter = getDateLabelFormatter(timezone);
    if (start.getTime() === yesterdayStart.getTime()) {
        return `Yesterday (${formatter.format(start)})`;
    }
    const weekdayFormatter = getWeekdayFormatter(timezone);
    const weekday = weekdayFormatter.format(start);
    return `${weekday} (${formatter.format(start)})`;
}

function formatWeekLabel(start: Date, end: Date, timezone: string, currentWeekStart: Date): string {
    const formatter = getDateLabelFormatter(timezone);
    const startLabel = formatter.format(start);
    const endLabel = formatter.format(addDays(end, -1, timezone));
    const prevWeekStart = addDays(currentWeekStart, -7, timezone);
    if (start.getTime() === prevWeekStart.getTime()) {
        return `Last Week (${startLabel} – ${endLabel})`;
    }
    return `Week of ${startLabel} – ${endLabel}`;
}

function formatMonthLabel(start: Date, timezone: string, currentMonthStart: Date): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        month: 'long',
        year: 'numeric',
    });
    const label = formatter.format(start);
    const previousMonthStart = addMonths(currentMonthStart, -1, timezone);
    if (start.getTime() === previousMonthStart.getTime()) {
        return `Last Month (${label})`;
    }
    return label;
}

function createAssemblyKey(level: SummaryLevel, startIso: string): string {
    return `${level}:${startIso}`;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function getTimeFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = timeFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        timeFormatters.set(timeZone, formatter);
    }
    return formatter;
}

function createSummaryIntro(prefix: string, label: string, prompt: string): string[] {
    const lines = [`${prefix} — ${label}`];
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length > 0) {
        lines.push(`Guided by prompt: ${truncateContent(trimmedPrompt, 240)}`);
    }
    return lines;
}

function renderDaySummary(label: string, timezone: string, prompt: string, messages: ConversationMessage[]): string {
    const formatter = getTimeFormatter(timezone);
    const intro = createSummaryIntro('Daily Summary', label, prompt);
    const lines = messages.map((message) => {
        const timestamp = formatter.format(new Date(message.created_at));
        const content = truncateContent(extractStringContent(message.content));
        return `- [${timestamp}] ${message.role}: ${content}`;
    });
    return [...intro, '', ...lines].join('\n');
}

function renderWeekSummary(label: string, timezone: string, prompt: string, daySummaries: ConversationSummary[]): string {
    const dayLabelFormatter = getDateLabelFormatter(timezone);
    const intro = createSummaryIntro('Weekly Summary', label, prompt);
    const lines = daySummaries.map((summary) => {
        const labelForDay = dayLabelFormatter.format(new Date(summary.period_start));
        return `- ${labelForDay}: ${truncateContent(summary.content, 480)}`;
    });
    return [...intro, '', ...lines].join('\n');
}

function renderMonthSummary(label: string, timezone: string, prompt: string, daySummaries: ConversationSummary[]): string {
    const dayLabelFormatter = getDateLabelFormatter(timezone);
    const intro = createSummaryIntro('Monthly Summary', label, prompt);
    const lines = daySummaries.map((summary) => {
        const labelForDay = dayLabelFormatter.format(new Date(summary.period_start));
        return `- ${labelForDay}: ${truncateContent(summary.content, 480)}`;
    });
    return [...intro, '', ...lines].join('\n');
}

export class SummariesService {
    constructor(private readonly supabase: SupabaseClient<any, any, any, any, any>, private readonly emitEvent?: SummaryEventEmitter) {}

    private async resolveTimezone(requested?: string | null): Promise<string> {
        const normalized = normalizeTimezone(requested);
        if (requested && normalized === requested) {
            return normalized;
        }
        if (!requested) {
            try {
                const { data, error } = await this.supabase
                    .from('user_settings')
                    .select('value')
                    .eq('key', 'timezone')
                    .maybeSingle();
                if (!error && data?.value) {
                    return normalizeTimezone(data.value as string);
                }
            } catch (error) {
                console.warn('Failed to resolve timezone from user settings:', error);
            }
        }
        return normalized;
    }

    private async fetchMessages(conversationId: string): Promise<ConversationMessage[]> {
        const { data, error } = await this.supabase
            .from('conversation_messages')
            .select('id, conversation_id, role, content, created_at, parent_message_id')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true });
        if (error) {
            throw new Error(`Failed to fetch conversation messages: ${error.message}`);
        }
        if (!data) {
            return [];
        }
        return data as ConversationMessage[];
    }

    private buildAncestry(messages: ConversationMessage[], currentMessageId: string): { ancestrySet: Set<string>; currentMessage: ConversationMessage } {
        const map = new Map<string, ConversationMessage>();
        for (const message of messages) {
            map.set(message.id, message);
        }
        const current = map.get(currentMessageId);
        if (!current) {
            throw new Error(`Message '${currentMessageId}' was not found in the conversation.`);
        }
        const ancestry = new Set<string>();
        let cursor: ConversationMessage | undefined = current;
        const guard = new Set<string>();
        while (cursor) {
            if (guard.has(cursor.id)) {
                break;
            }
            guard.add(cursor.id);
            ancestry.add(cursor.id);
            if (!cursor.parent_message_id) {
                break;
            }
            cursor = map.get(cursor.parent_message_id) ?? undefined;
        }
        return { ancestrySet: ancestry, currentMessage: current };
    }

    private buildConversationContext(messages: ConversationMessage[], currentMessageId: string, timezone: string): ConversationContext {
        const { ancestrySet, currentMessage } = this.buildAncestry(messages, currentMessageId);
        const branchMessages = messages.filter((msg) => ancestrySet.has(msg.id));
        const branchMessagesSorted = branchMessages.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        const messagesByDay = groupMessagesByDay(branchMessagesSorted, timezone);
        const currentDate = new Date(currentMessage.created_at);
        const todayStart = startOfDay(currentDate, timezone);
        const todayEnd = addDays(todayStart, 1, timezone);
        const yesterdayStart = addDays(todayStart, -1, timezone);
        const currentWeekStart = startOfWeek(todayStart, timezone);
        const currentMonthStart = startOfMonth(todayStart, timezone);
        return {
            timezone,
            currentMessage,
            messages,
            ancestrySet,
            branchMessages,
            branchMessagesSorted,
            messagesByDay,
            todayStart,
            todayEnd,
            yesterdayStart,
            currentWeekStart,
            currentMonthStart,
        };
    }

    private async fetchSummaries(conversationId: string): Promise<SummaryCache> {
        const { data, error } = await this.supabase
            .from('conversation_summaries')
            .select('id, conversation_id, level, period_start, period_end, content, created_by_message_id, created_at, updated_at')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true });
        if (error) {
            throw new Error(`Failed to fetch conversation summaries: ${error.message}`);
        }
        const byKey = new Map<string, ConversationSummary[]>();
        if (data) {
            for (const row of data as ConversationSummary[]) {
                const key = summaryCacheKey(row.level, row.period_start);
                if (!byKey.has(key)) {
                    byKey.set(key, []);
                }
                byKey.get(key)!.push(row);
            }
        }
        return { byKey };
    }

    private pickSummary(level: SummaryLevel, periodStartIso: string, cache: SummaryCache, ancestry: Set<string>): { summary: ConversationSummary | null; status: 'missing' | 'invalid' | 'reused'; invalidCandidate?: ConversationSummary } {
        const key = summaryCacheKey(level, periodStartIso);
        const summaries = cache.byKey.get(key);
        if (!summaries || summaries.length === 0) {
            return { summary: null, status: 'missing' };
        }
        const reusable = summaries.find((candidate) => candidate.created_by_message_id && ancestry.has(candidate.created_by_message_id));
        if (reusable) {
            return { summary: reusable, status: 'reused' };
        }
        return { summary: summaries[summaries.length - 1], status: 'invalid', invalidCandidate: summaries[summaries.length - 1] };
    }

    private emit(event: string, payload: Record<string, unknown>) {
        try {
            this.emitEvent?.(event, payload);
        } catch (error) {
            console.error('Failed to emit SSE event', { event, error });
        }
    }

    private computeRequiredPeriods(context: ConversationContext): { days: PeriodDescriptor[]; weeks: PeriodDescriptor[]; months: PeriodDescriptor[] } {
        const { messagesByDay, timezone, todayStart, yesterdayStart, currentWeekStart, currentMonthStart } = context;
        const dayStarts = Array.from(messagesByDay.keys()).map(parseISODate).sort(compareAsc);

        const previousDays: PeriodDescriptor[] = [];
        for (const start of dayStarts) {
            if (start.getTime() >= currentWeekStart.getTime() && start.getTime() < yesterdayStart.getTime()) {
                const end = addDays(start, 1, timezone);
                const label = formatDayLabel(start, timezone, todayStart, yesterdayStart);
                previousDays.push({ level: 'DAY', start, end, label, humanLabel: label });
            }
        }

        previousDays.sort((a, b) => compareAsc(a.start, b.start));

        const yesterdayDescriptor: PeriodDescriptor = {
            level: 'DAY',
            start: yesterdayStart,
            end: addDays(yesterdayStart, 1, timezone),
            label: formatDayLabel(yesterdayStart, timezone, todayStart, yesterdayStart),
            humanLabel: formatDayLabel(yesterdayStart, timezone, todayStart, yesterdayStart),
        };

        const dayDescriptors = [...previousDays, yesterdayDescriptor];

        const weekMap = new Map<string, PeriodDescriptor>();
        for (const start of dayStarts) {
            if (start.getTime() >= currentWeekStart.getTime()) {
                continue;
            }
            if (start.getTime() < currentMonthStart.getTime()) {
                continue;
            }
            const weekStart = startOfWeek(start, timezone);
            if (weekStart.getTime() < currentMonthStart.getTime()) {
                continue;
            }
            const weekKey = iso(weekStart);
            if (!weekMap.has(weekKey)) {
                const weekEnd = addDays(weekStart, 7, timezone);
                const label = formatWeekLabel(weekStart, weekEnd, timezone, currentWeekStart);
                weekMap.set(weekKey, {
                    level: 'WEEK',
                    start: weekStart,
                    end: weekEnd,
                    label,
                    humanLabel: label,
                });
            }
        }
        const weekDescriptors = Array.from(weekMap.values()).sort((a, b) => compareAsc(a.start, b.start));

        const monthMap = new Map<string, PeriodDescriptor>();
        for (const start of dayStarts) {
            if (start.getTime() >= currentMonthStart.getTime()) {
                continue;
            }
            const monthStart = startOfMonth(start, timezone);
            const monthKey = iso(monthStart);
            if (!monthMap.has(monthKey)) {
                const monthEnd = addMonths(monthStart, 1, timezone);
                const label = formatMonthLabel(monthStart, timezone, currentMonthStart);
                monthMap.set(monthKey, {
                    level: 'MONTH',
                    start: monthStart,
                    end: monthEnd,
                    label,
                    humanLabel: label,
                });
            }
        }
        const monthDescriptors = Array.from(monthMap.values()).sort((a, b) => compareAsc(a.start, b.start));

        return { days: dayDescriptors, weeks: weekDescriptors, months: monthDescriptors };
    }

    private async ensureDaySummary(
        context: ConversationContext,
        period: PeriodDescriptor,
        cache: SummaryCache,
        generation: ComposeContextForTurnResult['generation'],
        resultCache: Map<string, ConversationSummary | null>,
        prompt: string,
    ): Promise<ConversationSummary | null> {
        const periodStartIso = iso(period.start);
        const key = summaryCacheKey('DAY', periodStartIso);
        if (resultCache.has(key)) {
            return resultCache.get(key) ?? null;
        }
        const messages = context.messagesByDay.get(periodStartIso) ?? [];
        if (messages.length === 0) {
            const reason = 'no_messages';
            generation.skipped.push({ level: 'DAY', period_start: periodStartIso, reason });
            this.emit('summary_skipped', {
                conversation_id: context.currentMessage.conversation_id,
                level: 'DAY',
                period_start: periodStartIso,
                period_end: iso(period.end),
                human_label: period.humanLabel,
                reason,
            });
            resultCache.set(key, null);
            return null;
        }

        const pick = this.pickSummary('DAY', periodStartIso, cache, context.ancestrySet);
        if (pick.status === 'reused' && pick.summary) {
            generation.reused.push({ level: 'DAY', period_start: periodStartIso, created_by_message_id: pick.summary.created_by_message_id });
            this.emit('summary_reused', {
                conversation_id: context.currentMessage.conversation_id,
                level: 'DAY',
                period_start: periodStartIso,
                period_end: iso(period.end),
                human_label: period.humanLabel,
                summary_id: pick.summary.id,
            });
            resultCache.set(key, pick.summary);
            return pick.summary;
        }

        this.emit('summary_started', {
            conversation_id: context.currentMessage.conversation_id,
            level: 'DAY',
            period_start: periodStartIso,
            period_end: iso(period.end),
            human_label: period.humanLabel,
        });

        const content = renderDaySummary(period.label, context.timezone, prompt, messages);
        const insertPayload = {
            conversation_id: context.currentMessage.conversation_id,
            level: 'DAY' as const,
            period_start: periodStartIso,
            period_end: iso(period.end),
            content,
            created_by_message_id: context.currentMessage.id,
        };
        const { data, error } = await this.supabase
            .from('conversation_summaries')
            .insert(insertPayload)
            .select()
            .single();
        if (error) {
            throw new Error(`Failed to persist day summary for ${periodStartIso}: ${error.message}`);
        }
        const summary = data as ConversationSummary;
        const cacheKey = summaryCacheKey('DAY', periodStartIso);
        if (!cache.byKey.has(cacheKey)) {
            cache.byKey.set(cacheKey, []);
        }
        cache.byKey.get(cacheKey)!.push(summary);
        generation.generated.push({ level: 'DAY', period_start: periodStartIso, created_by_message_id: summary.created_by_message_id });
        this.emit('summary_completed', {
            conversation_id: context.currentMessage.conversation_id,
            level: 'DAY',
            period_start: periodStartIso,
            period_end: iso(period.end),
            human_label: period.humanLabel,
            summary_id: summary.id,
        });
        resultCache.set(key, summary);
        return summary;
    }

    private async ensureWeekSummary(
        context: ConversationContext,
        period: PeriodDescriptor,
        cache: SummaryCache,
        generation: ComposeContextForTurnResult['generation'],
        resultCache: Map<string, ConversationSummary | null>,
        prompt: string,
    ): Promise<ConversationSummary | null> {
        const periodStartIso = iso(period.start);
        const key = summaryCacheKey('WEEK', periodStartIso);
        if (resultCache.has(key)) {
            return resultCache.get(key) ?? null;
        }

        const daySummaries: ConversationSummary[] = [];
        for (let i = 0; i < 7; i += 1) {
            const dayStart = addDays(period.start, i, context.timezone);
            if (dayStart.getTime() >= period.end.getTime()) {
                break;
            }
            const descriptor: PeriodDescriptor = {
                level: 'DAY',
                start: dayStart,
                end: addDays(dayStart, 1, context.timezone),
                label: formatDayLabel(dayStart, context.timezone, context.todayStart, context.yesterdayStart),
                humanLabel: formatDayLabel(dayStart, context.timezone, context.todayStart, context.yesterdayStart),
            };
            const summary = await this.ensureDaySummary(context, descriptor, cache, generation, resultCache, prompt);
            if (summary) {
                daySummaries.push(summary);
            }
        }

        if (daySummaries.length === 0) {
            const reason = 'no_day_summaries';
            generation.skipped.push({ level: 'WEEK', period_start: periodStartIso, reason });
            this.emit('summary_skipped', {
                conversation_id: context.currentMessage.conversation_id,
                level: 'WEEK',
                period_start: periodStartIso,
                period_end: iso(period.end),
                human_label: period.humanLabel,
                reason,
            });
            resultCache.set(key, null);
            return null;
        }

        const pick = this.pickSummary('WEEK', periodStartIso, cache, context.ancestrySet);
        if (pick.status === 'reused' && pick.summary) {
            generation.reused.push({ level: 'WEEK', period_start: periodStartIso, created_by_message_id: pick.summary.created_by_message_id });
            this.emit('summary_reused', {
                conversation_id: context.currentMessage.conversation_id,
                level: 'WEEK',
                period_start: periodStartIso,
                period_end: iso(period.end),
                human_label: period.humanLabel,
                summary_id: pick.summary.id,
            });
            resultCache.set(key, pick.summary);
            return pick.summary;
        }

        this.emit('summary_started', {
            conversation_id: context.currentMessage.conversation_id,
            level: 'WEEK',
            period_start: periodStartIso,
            period_end: iso(period.end),
            human_label: period.humanLabel,
        });

        const sortedDaySummaries = daySummaries.sort((a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime());
        const content = renderWeekSummary(period.label, context.timezone, prompt, sortedDaySummaries);
        const insertPayload = {
            conversation_id: context.currentMessage.conversation_id,
            level: 'WEEK' as const,
            period_start: periodStartIso,
            period_end: iso(period.end),
            content,
            created_by_message_id: context.currentMessage.id,
        };
        const { data, error } = await this.supabase
            .from('conversation_summaries')
            .insert(insertPayload)
            .select()
            .single();
        if (error) {
            throw new Error(`Failed to persist week summary for ${periodStartIso}: ${error.message}`);
        }
        const summary = data as ConversationSummary;
        const cacheKey = summaryCacheKey('WEEK', periodStartIso);
        if (!cache.byKey.has(cacheKey)) {
            cache.byKey.set(cacheKey, []);
        }
        cache.byKey.get(cacheKey)!.push(summary);
        generation.generated.push({ level: 'WEEK', period_start: periodStartIso, created_by_message_id: summary.created_by_message_id });
        this.emit('summary_completed', {
            conversation_id: context.currentMessage.conversation_id,
            level: 'WEEK',
            period_start: periodStartIso,
            period_end: iso(period.end),
            human_label: period.humanLabel,
            summary_id: summary.id,
        });
        resultCache.set(key, summary);
        return summary;
    }

    private async ensureMonthSummary(
        context: ConversationContext,
        period: PeriodDescriptor,
        cache: SummaryCache,
        generation: ComposeContextForTurnResult['generation'],
        resultCache: Map<string, ConversationSummary | null>,
        prompt: string,
    ): Promise<ConversationSummary | null> {
        const periodStartIso = iso(period.start);
        const key = summaryCacheKey('MONTH', periodStartIso);
        if (resultCache.has(key)) {
            return resultCache.get(key) ?? null;
        }

        const daySummaries: ConversationSummary[] = [];
        let cursor = new Date(period.start.getTime());
        while (cursor.getTime() < period.end.getTime()) {
            const descriptor: PeriodDescriptor = {
                level: 'DAY',
                start: cursor,
                end: addDays(cursor, 1, context.timezone),
                label: formatDayLabel(cursor, context.timezone, context.todayStart, context.yesterdayStart),
                humanLabel: formatDayLabel(cursor, context.timezone, context.todayStart, context.yesterdayStart),
            };
            const summary = await this.ensureDaySummary(context, descriptor, cache, generation, resultCache, prompt);
            if (summary) {
                daySummaries.push(summary);
            }
            cursor = addDays(cursor, 1, context.timezone);
        }

        if (daySummaries.length === 0) {
            const reason = 'no_day_summaries';
            generation.skipped.push({ level: 'MONTH', period_start: periodStartIso, reason });
            this.emit('summary_skipped', {
                conversation_id: context.currentMessage.conversation_id,
                level: 'MONTH',
                period_start: periodStartIso,
                period_end: iso(period.end),
                human_label: period.humanLabel,
                reason,
            });
            resultCache.set(key, null);
            return null;
        }

        const pick = this.pickSummary('MONTH', periodStartIso, cache, context.ancestrySet);
        if (pick.status === 'reused' && pick.summary) {
            generation.reused.push({ level: 'MONTH', period_start: periodStartIso, created_by_message_id: pick.summary.created_by_message_id });
            this.emit('summary_reused', {
                conversation_id: context.currentMessage.conversation_id,
                level: 'MONTH',
                period_start: periodStartIso,
                period_end: iso(period.end),
                human_label: period.humanLabel,
                summary_id: pick.summary.id,
            });
            resultCache.set(key, pick.summary);
            return pick.summary;
        }

        this.emit('summary_started', {
            conversation_id: context.currentMessage.conversation_id,
            level: 'MONTH',
            period_start: periodStartIso,
            period_end: iso(period.end),
            human_label: period.humanLabel,
        });

        const sortedDaySummaries = daySummaries.sort((a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime());
        const content = renderMonthSummary(period.label, context.timezone, prompt, sortedDaySummaries);
        const insertPayload = {
            conversation_id: context.currentMessage.conversation_id,
            level: 'MONTH' as const,
            period_start: periodStartIso,
            period_end: iso(period.end),
            content,
            created_by_message_id: context.currentMessage.id,
        };
        const { data, error } = await this.supabase
            .from('conversation_summaries')
            .insert(insertPayload)
            .select()
            .single();
        if (error) {
            throw new Error(`Failed to persist month summary for ${periodStartIso}: ${error.message}`);
        }
        const summary = data as ConversationSummary;
        const cacheKey = summaryCacheKey('MONTH', periodStartIso);
        if (!cache.byKey.has(cacheKey)) {
            cache.byKey.set(cacheKey, []);
        }
        cache.byKey.get(cacheKey)!.push(summary);
        generation.generated.push({ level: 'MONTH', period_start: periodStartIso, created_by_message_id: summary.created_by_message_id });
        this.emit('summary_completed', {
            conversation_id: context.currentMessage.conversation_id,
            level: 'MONTH',
            period_start: periodStartIso,
            period_end: iso(period.end),
            human_label: period.humanLabel,
            summary_id: summary.id,
        });
        resultCache.set(key, summary);
        return summary;
    }

    async composeContextForTurn(input: ComposeContextForTurnInput): Promise<ComposeContextForTurnResult> {
        if (input.mode !== 'intelligent') {
            throw new Error(`Unsupported summarization mode '${input.mode}'. Only 'intelligent' is available.`);
        }
        const timezone = await this.resolveTimezone(input.timezone);
        const messages = await this.fetchMessages(input.conversationId);
        const context = this.buildConversationContext(messages, input.currentMessageId, timezone);
        const cache = await this.fetchSummaries(input.conversationId);
        const periods = this.computeRequiredPeriods(context);
        const resultCache = new Map<string, ConversationSummary | null>();
        const generation: ComposeContextForTurnResult['generation'] = {
            generated: [],
            reused: [],
            skipped: [],
        };
        const prompt = input.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;

        const monthEntries = [] as Array<{ descriptor: PeriodDescriptor; summary: ConversationSummary }>;
        for (const descriptor of periods.months) {
            const summary = await this.ensureMonthSummary(context, descriptor, cache, generation, resultCache, prompt);
            if (summary) {
                monthEntries.push({ descriptor, summary });
            }
        }

        const weekEntries = [] as Array<{ descriptor: PeriodDescriptor; summary: ConversationSummary }>;
        for (const descriptor of periods.weeks) {
            const summary = await this.ensureWeekSummary(context, descriptor, cache, generation, resultCache, prompt);
            if (summary) {
                weekEntries.push({ descriptor, summary });
            }
        }

        const dayDescriptors = periods.days;
        const previousDayDescriptors = dayDescriptors.slice(0, Math.max(dayDescriptors.length - 1, 0));
        const yesterdayDescriptor = dayDescriptors[dayDescriptors.length - 1];

        const priorDayEntries = [] as Array<{ descriptor: PeriodDescriptor; summary: ConversationSummary }>;
        for (const descriptor of previousDayDescriptors) {
            const summary = await this.ensureDaySummary(context, descriptor, cache, generation, resultCache, prompt);
            if (summary) {
                priorDayEntries.push({ descriptor, summary });
            }
        }

        let yesterdayEntry: { descriptor: PeriodDescriptor; summary: ConversationSummary } | null = null;
        if (yesterdayDescriptor) {
            const summary = await this.ensureDaySummary(context, yesterdayDescriptor, cache, generation, resultCache, prompt);
            if (summary) {
                yesterdayEntry = { descriptor: yesterdayDescriptor, summary };
            }
        }

        const systemSummaries: ComposeContextForTurnResult['composed_context']['system_summaries'] = [];
        const assemblyOrder: string[] = [];

        for (const { descriptor, summary } of monthEntries) {
            systemSummaries.push({
                level: 'MONTH',
                label: descriptor.label,
                period_start: iso(descriptor.start),
                period_end: iso(descriptor.end),
                content: summary.content,
            });
            assemblyOrder.push(createAssemblyKey('MONTH', iso(descriptor.start)));
        }

        for (const { descriptor, summary } of weekEntries) {
            systemSummaries.push({
                level: 'WEEK',
                label: descriptor.label,
                period_start: iso(descriptor.start),
                period_end: iso(descriptor.end),
                content: summary.content,
            });
            assemblyOrder.push(createAssemblyKey('WEEK', iso(descriptor.start)));
        }

        for (const { descriptor, summary } of priorDayEntries) {
            systemSummaries.push({
                level: 'DAY',
                label: descriptor.label,
                period_start: iso(descriptor.start),
                period_end: iso(descriptor.end),
                content: summary.content,
            });
            assemblyOrder.push(createAssemblyKey('DAY', iso(descriptor.start)));
        }

        if (yesterdayEntry) {
            systemSummaries.push({
                level: 'DAY',
                label: yesterdayEntry.descriptor.label,
                period_start: iso(yesterdayEntry.descriptor.start),
                period_end: iso(yesterdayEntry.descriptor.end),
                content: yesterdayEntry.summary.content,
            });
            assemblyOrder.push(createAssemblyKey('DAY', iso(yesterdayEntry.descriptor.start)));
        }

        const todayMessages = context.branchMessagesSorted.filter((message) => {
            const timestamp = new Date(message.created_at).getTime();
            return timestamp >= context.todayStart.getTime() && timestamp < context.todayEnd.getTime();
        });

        const earlierMessages = context.branchMessagesSorted.filter((message) => new Date(message.created_at).getTime() < context.todayStart.getTime());
        const rawTail = earlierMessages.slice(Math.max(earlierMessages.length - 6, 0));

        assemblyOrder.push('RAW:today');
        assemblyOrder.push('RAW:tail');

        const systemTokens = systemSummaries.reduce((acc, summary) => acc + estimateTokensFromText(summary.content), 0);
        const rawTokens = estimateTokensForMessages([...todayMessages, ...rawTail]);
        const totalTokens = systemTokens + rawTokens;

        this.emit('context_composed', {
            conversation_id: context.currentMessage.conversation_id,
            estimated_tokens: {
                system_summaries: systemTokens,
                raw: rawTokens,
                total: totalTokens,
            },
        });

        return {
            composed_context: {
                system_summaries: systemSummaries,
                raw_messages_today: todayMessages,
                raw_tail_across_boundary: rawTail,
                assembly_order: assemblyOrder,
                token_estimates: {
                    system_summaries_tokens: systemTokens,
                    raw_tokens: rawTokens,
                    total_tokens: totalTokens,
                },
            },
            generation,
            policy: {
                boundaries: {
                    day: 'midnight',
                    week: 'sunday_midnight',
                    month: 'calendar_month_end_midnight',
                    timezone,
                },
                inclusion: {
                    include_yesterday_summary: true,
                    include_all_today_raw: true,
                    include_tail_last_6: true,
                },
            },
        };
    }

    async listRequiredSummaries(input: ListRequiredSummariesInput): Promise<{ required: ListRequiredSummaryEntry[] }> {
        const timezone = await this.resolveTimezone(input.timezone);
        const messages = await this.fetchMessages(input.conversationId);
        const context = this.buildConversationContext(messages, input.currentMessageId, timezone);
        const cache = await this.fetchSummaries(input.conversationId);
        const periods = this.computeRequiredPeriods(context);
        const required: ListRequiredSummaryEntry[] = [];

        const evaluate = (level: SummaryLevel, descriptor: PeriodDescriptor) => {
            const periodStartIso = iso(descriptor.start);
            const pick = this.pickSummary(level, periodStartIso, cache, context.ancestrySet);
            if (pick.status === 'reused' && pick.summary) {
                required.push({ level, period_start: periodStartIso, status: 'exists', candidate_summary_id: pick.summary.id });
            } else if (pick.status === 'invalid' && pick.summary) {
                required.push({ level, period_start: periodStartIso, status: 'invalid', candidate_summary_id: pick.summary.id });
            } else {
                required.push({ level, period_start: periodStartIso, status: 'missing' });
            }
        };

        for (const descriptor of periods.months) {
            evaluate('MONTH', descriptor);
        }
        for (const descriptor of periods.weeks) {
            evaluate('WEEK', descriptor);
        }
        for (const descriptor of periods.days) {
            evaluate('DAY', descriptor);
        }

        return { required };
    }

    async getSummaries(input: GetSummariesInput): Promise<ConversationSummary[]> {
        let query = this.supabase
            .from('conversation_summaries')
            .select('id, conversation_id, level, period_start, period_end, content, created_by_message_id, created_at, updated_at')
            .eq('conversation_id', input.conversationId)
            .order('period_start', { ascending: true });

        if (input.levels && input.levels.length > 0) {
            query = query.in('level', input.levels);
        }
        if (input.start) {
            query = query.gte('period_start', input.start);
        }
        if (input.end) {
            query = query.lte('period_start', input.end);
        }

        const { data, error } = await query;
        if (error) {
            throw new Error(`Failed to fetch summaries: ${error.message}`);
        }
        return (data ?? []) as ConversationSummary[];
    }

    async generateSummary(input: GenerateSummaryInput): Promise<{ summary: ConversationSummary | null; generation: ComposeContextForTurnResult['generation'] }> {
        const timezone = await this.resolveTimezone(input.timezone);
        const messages = await this.fetchMessages(input.conversationId);
        const context = this.buildConversationContext(messages, input.currentMessageId, timezone);
        const cache = await this.fetchSummaries(input.conversationId);
        const resultCache = new Map<string, ConversationSummary | null>();
        const generation: ComposeContextForTurnResult['generation'] = {
            generated: [],
            reused: [],
            skipped: [],
        };
        const prompt = input.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;

        const startRaw = new Date(input.periodStart);
        if (Number.isNaN(startRaw.getTime())) {
            throw new Error(`Invalid periodStart '${input.periodStart}'.`);
        }

        let summary: ConversationSummary | null = null;
        switch (input.level) {
            case 'DAY': {
                const start = startOfDay(startRaw, timezone);
                const descriptor: PeriodDescriptor = {
                    level: 'DAY',
                    start,
                    end: addDays(start, 1, timezone),
                    label: formatDayLabel(start, timezone, context.todayStart, context.yesterdayStart),
                    humanLabel: formatDayLabel(start, timezone, context.todayStart, context.yesterdayStart),
                };
                summary = await this.ensureDaySummary(context, descriptor, cache, generation, resultCache, prompt);
                break;
            }
            case 'WEEK': {
                const start = startOfWeek(startRaw, timezone);
                const descriptor: PeriodDescriptor = {
                    level: 'WEEK',
                    start,
                    end: addDays(start, 7, timezone),
                    label: formatWeekLabel(start, addDays(start, 7, timezone), timezone, context.currentWeekStart),
                    humanLabel: formatWeekLabel(start, addDays(start, 7, timezone), timezone, context.currentWeekStart),
                };
                summary = await this.ensureWeekSummary(context, descriptor, cache, generation, resultCache, prompt);
                break;
            }
            case 'MONTH': {
                const start = startOfMonth(startRaw, timezone);
                const descriptor: PeriodDescriptor = {
                    level: 'MONTH',
                    start,
                    end: addMonths(start, 1, timezone),
                    label: formatMonthLabel(start, timezone, context.currentMonthStart),
                    humanLabel: formatMonthLabel(start, timezone, context.currentMonthStart),
                };
                summary = await this.ensureMonthSummary(context, descriptor, cache, generation, resultCache, prompt);
                break;
            }
            default:
                throw new Error(`Unsupported level '${input.level}'.`);
        }

        return { summary, generation };
    }
}

