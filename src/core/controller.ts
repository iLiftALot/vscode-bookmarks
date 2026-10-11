/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import path = require("path");
import os = require("os");
import * as vscode from "vscode";
import { Uri, WorkspaceFolder } from "vscode";
import { updateLinesWithBookmarkContext } from "../gutter/editorLineNumberContext";
import { getFileUri, getRelativePath, uriExists } from "../utils/fs";
import { Directions, NO_BOOKMARKS_AFTER, NO_BOOKMARKS_BEFORE, NO_MORE_BOOKMARKS, UNTITLED_SCHEME } from "./constants";
import { File, createFile } from "./file";
import { clear, getLinePreview, indexOfBookmark } from "./operations";

type StoredFile = Pick<File, "path" | "bookmarks">;

function isStoredFile(value: unknown): value is StoredFile {
    if (
        typeof value !== "object"
        || value === null
        || !("path" in value)
        || typeof value.path !== "string"
        || !("bookmarks" in value)
        || !Array.isArray(value.bookmarks)
    ) {
        return false;
    }

    return value.bookmarks.every((bookmark: unknown) =>
        typeof bookmark === "object"
        && bookmark !== null
        && "line" in bookmark
        && typeof bookmark.line === "number"
        && Number.isInteger(bookmark.line)
        && bookmark.line >= 0
        && "column" in bookmark
        && typeof bookmark.column === "number"
        && Number.isInteger(bookmark.column)
        && bookmark.column >= 0
        && (!("label" in bookmark) || bookmark.label === undefined || typeof bookmark.label === "string")
    );
}

interface BookmarkAdded {
    file: File;
    line: number;
    column: number;
    linePreview?: string;
    label?: string;
    uri: Uri;
}

interface BookmarkRemoved {
    bookmark: File;
    line: number;
}

interface BookmarkUpdated {
    file: File;
    index: number;
    line: number;
    column?: number;
    linePreview?: string;
    label?: string;
}

enum ToggleMode {
    allLinesAtOnce = "allLinesAtOnce",
    eachLineIndependently = "eachLineIndependently"
}

enum ToggleState {
    on = "on",
    off = "off",
    editLabel = "edit"
}

export enum BookmarkClearEventReason {
    singleFile,
    allFiles
}

export interface BookmarkClearEvent {
    file?: File | undefined;
    reason: BookmarkClearEventReason;
}

export class Controller {
    public files: File[];
    public workspaceFolder: WorkspaceFolder | undefined;

    private onDidClearBookmarksEmitter = new vscode.EventEmitter<BookmarkClearEvent>();
    get onDidClearBookmarks(): vscode.Event<BookmarkClearEvent> {
        return this.onDidClearBookmarksEmitter.event;
    }

    private onDidAddBookmarkEmitter = new vscode.EventEmitter<BookmarkAdded>();
    get onDidAddBookmark(): vscode.Event<BookmarkAdded> {
        return this.onDidAddBookmarkEmitter.event;
    }

    private onDidRemoveBookmarkEmitter = new vscode.EventEmitter<BookmarkRemoved>();
    get onDidRemoveBookmark(): vscode.Event<BookmarkRemoved> {
        return this.onDidRemoveBookmarkEmitter.event;
    }

    private onDidUpdateBookmarkEmitter = new vscode.EventEmitter<BookmarkUpdated>();
    get onDidUpdateBookmark(): vscode.Event<BookmarkUpdated> {
        return this.onDidUpdateBookmarkEmitter.event;
    }

    public static normalize(uri: string): string {
        // a simple workaround for what appears to be a vscode.Uri bug
        // (inconsistent fsPath values for the same document, ex. ///foo/x.cpp and /foo/x.cpp)
        return uri.replace("///", "/");
    }

    // public storage: Storage.BookmarksStorage;
    // public bookmarks: File[];
    public activeFile: File | undefined = undefined;

    constructor(workspaceFolder: WorkspaceFolder | undefined) {
        this.workspaceFolder = workspaceFolder;
        this.files = [];
    }

    public dispose() {
        this.zip();
    }

    public fromUri(uri: Uri) {
        if (uri.scheme === UNTITLED_SCHEME) {
            for (const file of this.files) {
                if (file.uri?.toString() === uri.toString()) {
                    return file;
                }
            }
            return;
        }

        const uriPath = !this.workspaceFolder
            ? uri.path
            : getRelativePath(this.workspaceFolder.uri.path, uri.path);

        for (const file of this.files) {
            if (file.path === uriPath) {
                return file;
            }
        }
    }

    public addFile(uri: Uri) {
        if (uri.scheme === UNTITLED_SCHEME) {
            // const untitleds = this.files.filter((file) => {
            //     return file.uri;
            // })?.map(file => file.path);

            // if (untitleds?.indexOf(uri.path) < 0) {
            //     const file = createFile(uri.path, uri);
            //     this.files.push(file);
            // }

            let file: File | undefined = this.files.find((f: File) => f.uri?.path === uri.path);
            if (!file) {
                file = createFile(uri.path, uri);
                this.files.push(file);
            }
            return;
        }

        const uriPath = !this.workspaceFolder
            ? uri.path
            : getRelativePath(this.workspaceFolder.uri.path, uri.path);

        const paths = this.files.map((file) => file.path);
        if (paths.indexOf(uriPath) < 0) {
            const bookmark = createFile(uriPath);
            this.files.push(bookmark);
        }
    }

    public requireFile(book?: File): File {
        const file = book ?? this.activeFile;

        if (file === undefined) {
            throw new Error("A bookmark file must be initialized before this operation.");
        }

        return file;
    }

    public requireActiveTextEditor(): vscode.TextEditor {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error("An active text editor must be available for this operation.");
        }
        return editor;
    }

    public requireWorkspaceFolder(): vscode.WorkspaceFolder {
        if (!this.workspaceFolder) {
            throw new Error("A workspace folder must be available for this operation.");
        }
        return this.workspaceFolder;
    }

    public async nextDocumentWithBookmarks(
        active: File,
        direction: Directions
    ): Promise<Uri | string | number> {
        const files = [ ...this.files ];
        const activeIndex = files.indexOf(active);
        if (activeIndex === -1) {
            return NO_MORE_BOOKMARKS;
        }

        const wrapNavigation = vscode.workspace.getConfiguration("bookmarks").get<boolean>("wrapNavigation", true);
        const step = direction === Directions.Forward ? 1 : -1;

        // Visit each file at most once, including the starting file only when wrapping.
        for (let offset = 1; offset <= files.length; offset++) {
            const index = activeIndex + offset * step;
            if (!wrapNavigation && (index < 0 || index >= files.length)) {
                return Promise.reject(direction === Directions.Forward ? NO_BOOKMARKS_AFTER : NO_BOOKMARKS_BEFORE);
            }

            const candidate = files[(index + files.length) % files.length];
            if (candidate.bookmarks.length === 0) {
                continue;
            }

            if (await uriExists(this.getFileUri(candidate))) {
                return candidate.uri ?? candidate.path;
            }
        }

        return NO_MORE_BOOKMARKS;
    }

    public clear(book?: File): void {
        const b: File = this.requireFile(book);
        clear(b);
        this.onDidClearBookmarksEmitter.fire({ file: b, reason: BookmarkClearEventReason.singleFile });
        updateLinesWithBookmarkContext(this.activeFile);
    }

    public clearAll(): void {
        for (const element of this.files) {
            clear(element);
        }
        this.onDidClearBookmarksEmitter.fire({ reason: BookmarkClearEventReason.allFiles });
        updateLinesWithBookmarkContext(this.activeFile);
    }

    private decideToggleState(selections: readonly vscode.Selection[], file: File): ToggleState {
        if (file.bookmarks.length === 0) {
            return ToggleState.on;
        }

        const lines = selections.map((item) => item.active.line);
        if (lines.every((elem) => file.bookmarks.map((item) => item.line).indexOf(elem) > -1)) {
            return ToggleState.off;
        } else {
            return ToggleState.on;
        }
    }

    public async toggle(selections: readonly vscode.Selection[], label?: string, book?: File): Promise<boolean> {
        const b: File = this.requireFile(book);
        const toggleMode = vscode.workspace.getConfiguration("bookmarks").get<string>(
            "multicursor.toggleMode",
            "allLinesAtOnce"
        );
        let toggleState: ToggleState | undefined;

        if (toggleMode === ToggleMode.allLinesAtOnce) {
            toggleState = this.decideToggleState(selections, b);
            if (toggleState === ToggleState.off && label !== undefined) {
                toggleState = ToggleState.editLabel;
            }
        }

        let added = false;
        const toggledLines: number[] = [];

        for (const selection of selections) {
            if (toggledLines.indexOf(selection.active.line) >= 0) {
                continue;
            }
            toggledLines.push(selection.active.line);

            if (toggleState === undefined) {
                // toggle off -> delete
                const index = indexOfBookmark(b, selection.active.line);
                if (index > -1) {
                    this.removeBookmark(index, selection.active.line, b);
                } else { // toggle on -> add
                    await this.addBookmark(selection.active, label, b);
                    added = true;
                }
            } else {
                const index = indexOfBookmark(b, selection.active.line);
                if (toggleState === ToggleState.editLabel) {
                    this.updateLabel(index, selection.active, label ?? "", b);
                } else if (toggleState === ToggleState.off) {
                    this.removeBookmark(index, selection.active.line, b);
                } else {
                    if (index === -1) {
                        await this.addBookmark(selection.active, label, b);
                    }
                    added = true;
                }
            }
        }

        return added;
    }

    public async addBookmark(position: vscode.Position, label?: string, book?: File): Promise<void> {
        const b: File = this.requireFile(book);
        if (!label) {
            b.bookmarks.push({
                line: position.line,
                column: position.character,
                label: ""
            });
            let linePreview: string;
            if (book) {
                linePreview = await getLinePreview(this.getFileUri(book), position.line);
            } else {
                linePreview = vscode.window.activeTextEditor?.document?.lineAt(position.line)?.text?.trim() ?? "";
            }

            this.onDidAddBookmarkEmitter.fire({
                file: b,
                line: position.line + 1,
                column: position.character + 1,
                linePreview,
                uri: this.getFileUri(b)
            });
        } else {
            b.bookmarks.push({
                line: position.line,
                column: position.character,
                label
            });
            this.onDidAddBookmarkEmitter.fire({
                file: b,
                line: position.line + 1,
                column: position.character + 1,
                label,
                uri: this.getFileUri(b)
            });
        }
    }

    public removeBookmark(index: number, aline: number, book?: File): void {
        const b: File = this.requireFile(book);
        b.bookmarks.splice(index, 1);
        this.onDidRemoveBookmarkEmitter.fire({
            bookmark: b,
            line: aline + 1
        });
    }

    private getVisibleLinePreview(file: File, line: number): string {
        const editor = vscode.window.visibleTextEditors.find((candidate) =>
            this.fromUri(candidate.document.uri) === file
        );

        if (!editor || line < 0 || line >= editor.document.lineCount) {
            return "";
        }

        return editor.document.lineAt(line).text.trim();
    }

    public updateLabel(index: number, position: vscode.Position, newLabel: string, book?: File): void {
        const file = this.requireFile(book);

        file.bookmarks[index].line = position.line;
        file.bookmarks[index].column = position.character;
        file.bookmarks[index].label = newLabel;

        if (newLabel === "" || newLabel === undefined) {
            this.onDidUpdateBookmarkEmitter.fire({
                file,
                index,
                line: position.line + 1,
                column: position.character + 1,
                linePreview: this.getVisibleLinePreview(file, position.line)
            });
        } else {
            this.onDidUpdateBookmarkEmitter.fire({
                file,
                index,
                line: position.line + 1,
                column: position.character + 1,
                label: newLabel
            });
        }
    }

    public updateBookmark(index: number, oldLine: number, newLine: number, book?: File): void {
        const b: File = this.requireFile(book);
        b.bookmarks[index].line = newLine;

        if (!b.bookmarks[index].label) {
            this.onDidUpdateBookmarkEmitter.fire({
                file: b,
                index,
                line: newLine + 1,
                linePreview: this.getVisibleLinePreview(b, newLine)
            });
        } else {
            this.onDidUpdateBookmarkEmitter.fire({
                file: b,
                index,
                line: newLine + 1,
                label: b.bookmarks[index].label
            });
        }
    }

    public hasAnyBookmark(): boolean {
        // let totalBookmarkCount = 0;
        // for (const element of this.files) {
        //     totalBookmarkCount = totalBookmarkCount + element.bookmarks.length;
        // }
        // return totalBookmarkCount > 0;
        return this.countBookmarks() > 0;
    }

    public countBookmarks(): number {
        let totalBookmarkCount = 0;
        for (const element of this.files) {
            totalBookmarkCount = totalBookmarkCount + element.bookmarks.length;
        }
        return totalBookmarkCount;
    }

    public countFilesWithBookmarks(): number {
        let totalFilesWithBookmarks = 0;
        for (const element of this.files) {
            if (element.bookmarks.length > 0) {
                totalFilesWithBookmarks++;
            }
        }
        return totalFilesWithBookmarks;
    }

    public loadFrom(jsonObject: unknown, relativePath?: boolean): void {
        if (jsonObject === "") {
            return;
        }

        const isVersion2 = Array.isArray(jsonObject);
        const isVersion1 = typeof jsonObject === "object" && jsonObject !== null && "bookmarks" in jsonObject;
        const files = isVersion2
            ? jsonObject
            : isVersion1
            ? jsonObject.bookmarks
            : typeof jsonObject === "object" && jsonObject !== null && "files" in jsonObject
            ? jsonObject.files
            : undefined;

        if (!Array.isArray(files) || !files.every(isStoredFile)) {
            throw new TypeError("Invalid bookmark storage data.");
        }

        const loadedFiles = files
            .filter((file) => !isVersion2 || !/Untitled-\d+/.test(file.path))
            .map((file) => {
                const legacyFormat = isVersion1 || isVersion2;
                const filePath = !legacyFormat
                    ? file.path
                    : relativePath
                    ? file.path.replace(`$ROOTPATH$${path.sep}`, "")
                    : getRelativePath(this.workspaceFolder?.uri.fsPath, file.path);
                const bookmarkFile = createFile(filePath);

                if (legacyFormat && os.platform() === "win32") {
                    bookmarkFile.path = bookmarkFile.path.replace(/\\/g, "/");
                }

                bookmarkFile.bookmarks = file.bookmarks.map((bookmark) => ({ ...bookmark }));
                return bookmarkFile;
            });

        this.files.push(...loadedFiles);
    }

    public zip(): { files: StoredFile[] } {
        return {
            files: this
                .files
                .filter((file) => !file.uri && file.bookmarks.length > 0)
                .map((file) => ({
                    path: file.path,
                    bookmarks: file.bookmarks.map((bookmark) => ({ ...bookmark }))
                }))
        };
    }

    // private updateRelativePath = (path: string): string => {
    //     const wsPath: vscode.WorkspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path));
    //     if (wsPath) {
    //         path = path.replace(wsPath.uri.fsPath, "$ROOTPATH$");
    //     }
    //     return path;
    // }
    public updateFilePath(oldFilePath: string, newFilePath: string): void {
        for (const file of this.files) {
            if (file.path === oldFilePath) {
                file.path = newFilePath;
                break;
            }
        }
    }

    public updateDirectoryPath(oldDirectoryPath: string, newDirectoryPath: string): void {
        for (const file of this.files) {
            if (file.path.startsWith(oldDirectoryPath)) {
                file.path = file.path.replace(oldDirectoryPath, newDirectoryPath);
            }
        }
    }

    public getFileUri(file: File): Uri {
        return getFileUri(file, this.workspaceFolder);
    }
}
