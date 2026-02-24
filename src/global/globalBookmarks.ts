/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, EventEmitter, l10n, Uri, window, workspace } from "vscode";
import { Bookmark } from "../core/bookmark";
import { Container } from "../core/container";
import { logger } from "../utils/logger";

export const GLOBAL_BOOKMARKS_KEY = "globalBookmarks";
export const GLOBAL_SIDEBAR_HIDE_POSITION = "bookmarks.sidebar.hidePosition";
export const GLOBAL_VIEW_AS_LIST = "viewAsList";

export interface GlobalFile {
    path: string; // absolute file path
    bookmarks: Bookmark[];
}

interface GlobalBookmarkAdded {
    file: GlobalFile;
    line: number;
    column: number;
    linePreview?: string;
    label?: string;
    uri: Uri;
}

interface GlobalBookmarkRemoved {
    file: GlobalFile;
    line: number;
}

interface GlobalBookmarkUpdated {
    file: GlobalFile;
    index: number;
    line: number;
    column?: number;
    linePreview?: string;
    label?: string;
}

export class GlobalBookmarksManager {
    private _files: GlobalFile[] = [];

    private normalizePath(filePath: string): string {
        const normalized = filePath.replace(/\\/g, "/").replace(/\/+/g, "/");
        if (process.platform === "win32") {
            return normalized.toLowerCase();
        }

        return normalized;
    }

    private onDidChangeEmitter = new EventEmitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    private onDidAddBookmarkEmitter = new EventEmitter<GlobalBookmarkAdded>();
    readonly onDidAddBookmark: Event<GlobalBookmarkAdded> = this.onDidAddBookmarkEmitter.event;

    private onDidRemoveBookmarkEmitter = new EventEmitter<GlobalBookmarkRemoved>();
    readonly onDidRemoveBookmark: Event<GlobalBookmarkRemoved> = this.onDidRemoveBookmarkEmitter.event;

    private onDidUpdateBookmarkEmitter = new EventEmitter<GlobalBookmarkUpdated>();
    readonly onDidUpdateBookmark: Event<GlobalBookmarkUpdated> = this.onDidUpdateBookmarkEmitter.event;

    get files(): GlobalFile[] {
        return this._files;
    }

    public load(): void {
        const saved = Container.globalState.get(GLOBAL_BOOKMARKS_KEY, "");
        if (saved !== "") {
            try {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) {
                    this._files = parsed.map((file: GlobalFile) => ({
                        ...file,
                        path: this.normalizePath(file.path),
                    }));
                    logger.debug("globalBookmarks.GlobalBookmarksManager.load", "Loaded global bookmarks", {
                        files: this._files.length,
                        bookmarks: this.countBookmarks(),
                    });
                }
            } catch (e) {
                logger.error("globalBookmarks.GlobalBookmarksManager.load", "Error loading global bookmarks", e);
                window.showErrorMessage(l10n.t("Error loading global bookmarks: {0}", e.toString()));
                this._files = [];
            }
        }
    }

    public save(): void {
        const toSave = this._files
            .filter((f) => f.bookmarks.length > 0)
            .map((file) => ({
                ...file,
                path: this.normalizePath(file.path),
            }));
        Container.globalState.update(GLOBAL_BOOKMARKS_KEY, JSON.stringify(toSave));
        logger.debug("globalBookmarks.GlobalBookmarksManager.save", "Saved global bookmarks", {
            files: toSave.length,
            bookmarks: toSave.reduce((acc, file) => acc + file.bookmarks.length, 0),
        });
    }

    private getOrCreateFile(uri: Uri): GlobalFile {
        const filePath = this.normalizePath(uri.fsPath);
        let file = this._files.find((f) => f.path === filePath);
        if (!file) {
            file = { path: filePath, bookmarks: [] };
            this._files.push(file);
        }
        return file;
    }

    public fromUri(uri: Uri | undefined): GlobalFile | undefined {
        if (!uri) {
            return undefined;
        }

        const filePath = this.normalizePath(uri.fsPath);
        return this._files.find((f) => f.path === filePath);
    }

    public indexOfBookmark(file: GlobalFile, line: number): number {
        for (let index = 0; index < file.bookmarks.length; index++) {
            if (file.bookmarks[index].line === line) {
                return index;
            }
        }
        return -1;
    }

    public async toggle(uri: Uri, line: number, column: number, label?: string): Promise<boolean> {
        const file = this.getOrCreateFile(uri);
        const index = this.indexOfBookmark(file, line);

        if (index >= 0) {
            // toggle off - remove
            if (label !== undefined && label !== "") {
                // edit label instead
                file.bookmarks[index].label = label;
                this.onDidUpdateBookmarkEmitter.fire({
                    file,
                    index,
                    line: line + 1,
                    column: column + 1,
                    label,
                });
            } else {
                this.removeBookmark(file, index, line);
            }
            this.save();
            this.onDidChangeEmitter.fire();
            logger.debug("globalBookmarks.GlobalBookmarksManager.toggle", "Toggled global bookmark off", { path: uri.fsPath, line: line + 1, column: column + 1 });
            return false;
        } else {
            // toggle on - add
            await this.addBookmark(uri, line, column, label);
            this.save();
            this.onDidChangeEmitter.fire();
            logger.debug("globalBookmarks.GlobalBookmarksManager.toggle", "Toggled global bookmark on", { path: uri.fsPath, line: line + 1, column: column + 1, label });
            return true;
        }
    }

    public async addBookmark(uri: Uri, line: number, column: number, label?: string): Promise<void> {
        const file = this.getOrCreateFile(uri);
        file.bookmarks.push({
            line,
            column,
            label: label || "",
        });

        // Sort bookmarks by line
        file.bookmarks.sort((a, b) => a.line - b.line);

        let linePreview: string | undefined;
        try {
            const doc = await workspace.openTextDocument(uri);
            linePreview = doc.lineAt(line).text.trim();
        } catch {
            linePreview = "";
        }

        this.onDidAddBookmarkEmitter.fire({
            file,
            line: line + 1,
            column: column + 1,
            linePreview: label ? undefined : linePreview,
            label: label || undefined,
            uri,
        });
    }

    public removeBookmark(file: GlobalFile, index: number, line: number): void {
        file.bookmarks.splice(index, 1);
        this.onDidRemoveBookmarkEmitter.fire({
            file,
            line: line + 1,
        });
        logger.debug("globalBookmarks.GlobalBookmarksManager.removeBookmark", "Removed global bookmark");
    }

    public updateLabel(file: GlobalFile, index: number, line: number, column: number, newLabel: string): void {
        file.bookmarks[index].label = newLabel;
        file.bookmarks[index].line = line;
        file.bookmarks[index].column = column;

        if (newLabel === "" || newLabel === undefined) {
            this.onDidUpdateBookmarkEmitter.fire({
                file,
                index,
                line: line + 1,
                column: column + 1,
                linePreview: "", // will be resolved by the provider
            });
        } else {
            this.onDidUpdateBookmarkEmitter.fire({
                file,
                index,
                line: line + 1,
                column: column + 1,
                label: newLabel,
            });
        }
        this.save();
        this.onDidChangeEmitter.fire();
    }

    public clearFile(filePath: string): void {
        const normalizedPath = this.normalizePath(filePath);
        const file = this._files.find((f) => f.path === normalizedPath);
        if (file) {
            file.bookmarks = [];
        }
        this.save();
        this.onDidChangeEmitter.fire();
        logger.debug("globalBookmarks.GlobalBookmarksManager.clearFile", "Cleared global bookmarks from file", {
            filePath: normalizedPath,
            file,
        });
    }

    public clearAll(): void {
        this._files = [];
        this.save();
        this.onDidChangeEmitter.fire();
        logger.info("globalBookmarks.GlobalBookmarksManager.clearAll", "Cleared all global bookmarks");
    }

    public hasAnyBookmark(): boolean {
        return this._files.some((f) => f.bookmarks.length > 0);
    }

    public countBookmarks(): number {
        let total = 0;
        for (const file of this._files) {
            total += file.bookmarks.length;
        }
        return total;
    }

    public countFilesWithBookmarks(): number {
        return this._files.filter((f) => f.bookmarks.length > 0).length;
    }

    /**
     * Returns bookmarks for the given file URI (if any global bookmarks exist there)
     */
    public getBookmarksForFile(uri: Uri): Bookmark[] {
        const file = this.fromUri(uri);
        return file ? file.bookmarks : [];
    }

    /**
     * Update the line number of a bookmark at the given index.
     * Used by the sticky engine to keep bookmarks in sync with edits.
     */
    public updateBookmarkLine(file: GlobalFile, index: number, newLine: number): void {
        file.bookmarks[index].line = newLine;
    }

    /**
     * Remove a bookmark by its line number in the given file.
     * Returns true if a bookmark was removed.
     */
    public removeBookmarkByLine(file: GlobalFile, line: number): boolean {
        const index = this.indexOfBookmark(file, line);
        if (index >= 0) {
            file.bookmarks.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * Notify listeners and persist after sticky adjustments.
     */
    public notifyAndSave(): void {
        this.save();
        this.onDidChangeEmitter.fire();
    }

    public dispose(): void {
        this.onDidChangeEmitter.dispose();
        this.onDidAddBookmarkEmitter.dispose();
        this.onDidRemoveBookmarkEmitter.dispose();
        this.onDidUpdateBookmarkEmitter.dispose();
    }
}
