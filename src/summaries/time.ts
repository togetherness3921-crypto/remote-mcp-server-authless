const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (timeZone: string, options: Intl.DateTimeFormatOptions) => {
    const key = `${timeZone}:${JSON.stringify(options)}`;
    let formatter = dateTimeFormatterCache.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
        dateTimeFormatterCache.set(key, formatter);
    }
    return formatter;
};

const normalizeOffsetLabel = (label: string): string => {
    if (!label) {
        return "GMT";
    }
    if (label.startsWith("GMT")) {
        return label;
    }
    if (label.startsWith("UTC")) {
        return label.replace("UTC", "GMT");
    }
    return label;
};

const extractOffsetMinutes = (label: string): number => {
    const normalized = normalizeOffsetLabel(label);
    const match = normalized.match(/GMT([+-]\d{2})(?::(\d{2}))?/);
    if (!match) {
        return 0;
    }
    const sign = match[1][0] === "-" ? -1 : 1;
    const hours = Number.parseInt(match[1].slice(1), 10);
    const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
    return sign * (hours * 60 + minutes);
};

export class TimeHelper {
    private readonly timeZone: string;

    constructor(timeZone: string) {
        this.timeZone = timeZone;
    }

    getTimeZone(): string {
        return this.timeZone;
    }

    private getOffsetMinutes(date: Date): number {
        const formatter = getFormatter(this.timeZone, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour12: false,
            timeZoneName: "shortOffset",
        });
        const parts = formatter.formatToParts(date);
        const zoneLabel = parts.find(part => part.type === "timeZoneName")?.value ?? "GMT";
        return extractOffsetMinutes(zoneLabel);
    }

    private toLocalDate(date: Date): Date {
        const offset = this.getOffsetMinutes(date);
        return new Date(date.getTime() + offset * MS_PER_MINUTE);
    }

    private makeZonedDate(year: number, month: number, day: number, hour: number, minute: number, second = 0, millisecond = 0): Date {
        const baseUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
        let result = new Date(baseUtc);
        let offset = this.getOffsetMinutes(result);
        result = new Date(baseUtc - offset * MS_PER_MINUTE);
        let nextOffset = this.getOffsetMinutes(result);
        if (nextOffset !== offset) {
            result = new Date(baseUtc - nextOffset * MS_PER_MINUTE);
        }
        return result;
    }

    private getLocalComponents(date: Date) {
        const local = this.toLocalDate(date);
        return {
            year: local.getUTCFullYear(),
            month: local.getUTCMonth() + 1,
            day: local.getUTCDate(),
            hour: local.getUTCHours(),
            minute: local.getUTCMinutes(),
            second: local.getUTCSeconds(),
            dayOfWeek: local.getUTCDay(),
        };
    }

    startOfDay(date: Date): Date {
        const { year, month, day } = this.getLocalComponents(date);
        return this.makeZonedDate(year, month, day, 0, 0, 0, 0);
    }

    addDays(date: Date, days: number): Date {
        return new Date(date.getTime() + days * MS_PER_DAY);
    }

    getLocalDayOfWeek(date: Date): number {
        const local = this.toLocalDate(date);
        return local.getUTCDay();
    }

    startOfWeek(date: Date): Date {
        const start = this.startOfDay(date);
        const dayOfWeek = this.getLocalDayOfWeek(start);
        return this.addDays(start, -dayOfWeek);
    }

    startOfMonth(date: Date): Date {
        const { year, month } = this.getLocalComponents(date);
        return this.makeZonedDate(year, month, 1, 0, 0, 0, 0);
    }

    startOfNextMonth(date: Date): Date {
        const { year, month } = this.getLocalComponents(date);
        let nextYear = year;
        let nextMonth = month + 1;
        if (nextMonth > 12) {
            nextMonth = 1;
            nextYear += 1;
        }
        return this.makeZonedDate(nextYear, nextMonth, 1, 0, 0, 0, 0);
    }

    startOfPreviousMonth(date: Date): Date {
        const { year, month } = this.getLocalComponents(date);
        let prevYear = year;
        let prevMonth = month - 1;
        if (prevMonth < 1) {
            prevMonth = 12;
            prevYear -= 1;
        }
        return this.makeZonedDate(prevYear, prevMonth, 1, 0, 0, 0, 0);
    }

    formatDate(date: Date): string {
        const formatter = getFormatter(this.timeZone, {
            year: "numeric",
            month: "short",
            day: "numeric",
        });
        return formatter.format(date);
    }

    formatMonth(date: Date): string {
        const formatter = getFormatter(this.timeZone, {
            year: "numeric",
            month: "long",
        });
        return formatter.format(date);
    }

    formatWeekday(date: Date): string {
        const formatter = getFormatter(this.timeZone, {
            weekday: "long",
        });
        return formatter.format(date);
    }

    formatDateRange(start: Date, end: Date): string {
        const startLabel = this.formatDate(start);
        const endLabel = this.formatDate(this.addDays(end, -1));
        const [startMonth, ...startRest] = startLabel.split(" ");
        const [endMonth, ...endRest] = endLabel.split(" ");
        if (startMonth === endMonth) {
            return `${startMonth} ${startRest.join(" ")}-${endRest.join(" ")}`.trim();
        }
        return `${startLabel}–${endLabel}`;
    }

    getHumanDayLabel(dayStart: Date, todayStart: Date, yesterdayStart: Date): string {
        if (dayStart.getTime() === yesterdayStart.getTime()) {
            return `Yesterday (${this.formatDate(dayStart)})`;
        }
        const weekday = this.formatWeekday(dayStart);
        return `${weekday} (${this.formatDate(dayStart)})`;
    }

    getHumanWeekLabel(weekStart: Date, currentWeekStart: Date): string {
        const previousWeekStart = this.addDays(currentWeekStart, -7);
        const labelRange = this.formatDateRange(weekStart, this.addDays(weekStart, 7));
        if (weekStart.getTime() === previousWeekStart.getTime()) {
            return `Last Week (${labelRange})`;
        }
        return `Week of ${this.formatDate(weekStart)} (${labelRange})`;
    }

    getHumanMonthLabel(monthStart: Date, currentMonthStart: Date): string {
        const previousMonthStart = this.startOfPreviousMonth(currentMonthStart);
        const label = this.formatMonth(monthStart);
        if (monthStart.getTime() === previousMonthStart.getTime()) {
            return `Last Month (${label})`;
        }
        return `Month of ${label}`;
    }
}

export const summaryKey = (level: string, periodStart: string) => `${level}::${periodStart}`;

export const estimateTokenCount = (text: string): number => {
    if (!text) {
        return 0;
    }
    const normalized = text.trim();
    if (normalized.length === 0) {
        return 0;
    }
    return Math.max(1, Math.ceil(normalized.length / 4));
};

export const safeISO = (date: Date): string => date.toISOString();

export const clampPeriodEnd = (start: Date, days: number): Date => {
    return new Date(start.getTime() + days * MS_PER_DAY);
};

export const ensureChronological = <T extends { created_at?: string }>(items: T[]): T[] => {
    return [...items].sort((a, b) => {
        const aTime = a.created_at ? Date.parse(a.created_at) : 0;
        const bTime = b.created_at ? Date.parse(b.created_at) : 0;
        return aTime - bTime;
    });
};

