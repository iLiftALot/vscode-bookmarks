/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, ExtensionMode, OutputChannel, window } from "vscode";

type LogLevel = "debug" | "info" | "warn" | "error";

const levelRank: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

function modeName(mode: ExtensionMode): string {
    if (mode === ExtensionMode.Development) {
        return "development";
    }

    if (mode === ExtensionMode.Test) {
        return "test";
    }

    return "production";
}

class Logger {
    private channel: OutputChannel | undefined;
    private minimumLevel: LogLevel = "info";
    private isInitialized = false;
    private context: ExtensionContext;

    public initialize(context: ExtensionContext): void {
        if (this.isInitialized) {
            return;
        }
        this.context = context;
        this.channel = window.createOutputChannel("Bookmarks");
        this.context.subscriptions.push(this.channel);

        this.minimumLevel = this.context.extensionMode === ExtensionMode.Development ? "debug" : "info";
        this.isInitialized = true;

        this.info("logger", `initialized (mode=${modeName(this.context.extensionMode)}, level=${this.minimumLevel})`);

        this.determineVisibility();
    }

    public setLevel(level: LogLevel): void {
        this.minimumLevel = level;
        this.info("logger", `minimum level set to ${level}`);
    }

    public determineVisibility(): void {
        if (this.context.extensionMode === ExtensionMode.Development) {
            this.ensureChannel();
            this.channel.show(false); // make the channel take focus
            return;
        }
        this.channel.hide();
    }

    public debug(scope: string, message: string, data?: unknown): void {
        this.log("debug", scope, message, data);
    }

    public info(scope: string, message: string, data?: unknown): void {
        this.log("info", scope, message, data);
    }

    public warn(scope: string, message: string, data?: unknown): void {
        this.log("warn", scope, message, data);
    }

    public error(scope: string, message: string, data?: unknown): void {
        this.log("error", scope, message, data);
    }

    private log(level: LogLevel, scope: string, message: string, data?: unknown): void {
        if (levelRank[level] < levelRank[this.minimumLevel]) {
            return;
        }

        this.ensureChannel();
        const now = new Date().toLocaleString("en-US", {
            year: "2-digit",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZone: "EST",
            hour12: false
        });
        const metadata = this.serialize(data);
        const suffix = metadata === "" ? "" : ` | ${metadata}`;
        this.channel.appendLine(`[${now}] [${level.toUpperCase()}] [${scope}] ${message}${suffix}`);
    }

    private ensureChannel(): void {
        if (!this.channel) {
            this.channel = window.createOutputChannel("Bookmarks", { log: true });
            this.context.subscriptions.push(this.channel);
        }
    }

    private serialize(data: unknown): string {
        if (typeof data === "undefined") {
            return "";
        }

        const seen = new WeakMap<object, string>();

        const isJsonCandidate = (value: string): boolean => {
            const trimmed = value.trim();
            return (
                (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
                (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
                (trimmed.startsWith("\"") && trimmed.endsWith("\""))
            );
        };

        const tryParseJsonString = (value: string): unknown | undefined => {
            if (!isJsonCandidate(value)) {
                return undefined;
            }

            try {
                return JSON.parse(value);
            } catch {
                return undefined;
            }
        };

        const normalizeProperties = (target: object, path: string): Record<string, unknown> => {
            const normalized: Record<string, unknown> = {};

            for (const propertyKey of Reflect.ownKeys(target)) {
                const key =
                    typeof propertyKey === "symbol"
                        ? `[symbol:${propertyKey.description ?? propertyKey.toString()}]`
                        : propertyKey;

                try {
                    const value = (target as Record<PropertyKey, unknown>)[propertyKey];
                    normalized[key] = normalize(value, `${path}.${String(key)}`);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    normalized[key] = `[Thrown while reading property: ${reason}]`;
                }
            }

            return normalized;
        };

        const normalize = (value: unknown, path: string): unknown => {
            if (typeof value === "undefined") {
                return "[undefined]";
            }

            if (value === null) {
                return null;
            }

            if (typeof value === "string") {
                const parsed = tryParseJsonString(value);
                if (typeof parsed !== "undefined") {
                    return normalize(parsed, `${path}.$parsed`);
                }

                return value;
            }

            if (typeof value === "number") {
                if (Number.isNaN(value)) {
                    return "[Number:NaN]";
                }

                if (!Number.isFinite(value)) {
                    return `[Number:${value > 0 ? "Infinity" : "-Infinity"}]`;
                }

                return value;
            }

            if (typeof value === "boolean") {
                return value;
            }

            if (typeof value === "bigint") {
                return `${value.toString()}n`;
            }

            if (typeof value === "symbol") {
                return value.toString();
            }

            if (typeof value === "function") {
                const functionObject = value as unknown as object;
                if (seen.has(functionObject)) {
                    return `[Circular -> ${seen.get(functionObject)}]`;
                }

                seen.set(functionObject, path);

                const properties = normalizeProperties(functionObject, path);
                return {
                    __type: "Function",
                    name: (value as (...args: unknown[]) => unknown).name || "anonymous",
                    properties,
                };
            }

            const objectValue = value as object;
            if (seen.has(objectValue)) {
                return `[Circular -> ${seen.get(objectValue)}]`;
            }

            seen.set(objectValue, path);

            if (value instanceof Date) {
                return Number.isNaN(value.getTime()) ? "[Date:Invalid]" : value.toISOString();
            }

            if (value instanceof RegExp) {
                return value.toString();
            }

            if (value instanceof Error) {
                const errorData: Record<string, unknown> = {
                    __type: value.name || "Error",
                    message: value.message,
                    stack: value.stack,
                };

                const extra = normalizeProperties(value, path);
                for (const [key, entry] of Object.entries(extra)) {
                    if (key === "name" || key === "message" || key === "stack") {
                        continue;
                    }

                    errorData[key] = entry;
                }

                return errorData;
            }

            if (Array.isArray(value)) {
                return value.map((entry, index) => normalize(entry, `${path}[${index}]`));
            }

            if (value instanceof Map) {
                return {
                    __type: "Map",
                    entries: Array.from(value.entries()).map(([mapKey, mapValue], index) => ({
                        key: normalize(mapKey, `${path}.<mapKey:${index}>`),
                        value: normalize(mapValue, `${path}.<mapValue:${index}>`),
                    })),
                };
            }

            if (value instanceof Set) {
                return {
                    __type: "Set",
                    values: Array.from(value.values()).map((entry, index) => normalize(entry, `${path}.<set:${index}>`)),
                };
            }

            if (value instanceof WeakMap) {
                return "[WeakMap:entries-not-iterable]";
            }

            if (value instanceof WeakSet) {
                return "[WeakSet:entries-not-iterable]";
            }

            if (value instanceof Promise) {
                return "[Promise]";
            }

            if (value instanceof URL) {
                return value.toString();
            }

            if (value instanceof ArrayBuffer) {
                return {
                    __type: "ArrayBuffer",
                    byteLength: value.byteLength,
                    values: Array.from(new Uint8Array(value)),
                };
            }

            if (ArrayBuffer.isView(value)) {
                if (value instanceof DataView) {
                    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                    return {
                        __type: "DataView",
                        byteLength: value.byteLength,
                        values: Array.from(bytes),
                    };
                }

                return {
                    __type: value.constructor?.name ?? "TypedArray",
                    values: Array.from(value as unknown as ArrayLike<number>),
                };
            }

            return normalizeProperties(objectValue, path);
        };

        try {
            const normalized = normalize(data, "$root");
            return typeof normalized === "string" ? normalized : JSON.stringify(normalized, null, 4);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return `[Unserializable value: ${reason}]`;
        }
    }
}

export const logger = new Logger();
