/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position, Uri, workspace, WorkspaceFolder } from "vscode";
import { codicons } from "vscode-ext-codicons";
import { uriExists, uriWith } from "../utils/fs";
import { logger } from "../utils/logger";
import { Bookmark, BookmarkQuickPickItem } from "./bookmark";
import { Directions, NO_BOOKMARKS, NO_BOOKMARKS_AFTER, NO_BOOKMARKS_BEFORE, NO_MORE_BOOKMARKS } from "./constants";
import { File } from "./file";

export function nextBookmark(
    bookmarks: Bookmark[],
    currentPosition: Position,
    direction: Directions,
): Promise<number | Position> {
    logger.debug("operations.nextBookmark", "Finding next bookmark", {
        bookmarks: `${bookmarks.map((b) => ({ line: b.line, column: b.column })).slice(0, 5)}${bookmarks.length > 5 ? "..." : ""}`,
        currentPosition: { line: currentPosition.line, column: currentPosition.character },
        direction,
    });

    return new Promise((resolve, reject) => {
        if (typeof bookmarks === "undefined") {
            logger.error("operations.nextBookmark", "Bookmarks are undefined.");
            reject('typeof bookmarks == "undefined"');
            return;
        }

        const navigateThroughAllFiles: boolean = workspace
            .getConfiguration("bookmarks")
            .get("navigateThroughAllFiles", true);

        if (bookmarks.length === 0) {
            if (navigateThroughAllFiles) {
                resolve(NO_BOOKMARKS);
                return;
            } else {
                resolve(currentPosition);
                return;
            }
        }

        const wrapNavigation: boolean = workspace.getConfiguration("bookmarks").get("wrapNavigation", true);

        let nextBookmark: Position;

        if (direction === Directions.Forward) {
            for (const element of bookmarks) {
                if (element.line > currentPosition.line) {
                    nextBookmark = new Position(element.line, element.column); // .line
                    break;
                }
            }

            if (typeof nextBookmark === "undefined") {
                if (navigateThroughAllFiles) {
                    resolve(NO_MORE_BOOKMARKS);
                    return;
                } else if (!wrapNavigation) {
                    resolve(NO_BOOKMARKS_AFTER);
                    return;
                } else {
                    resolve(new Position(bookmarks[0].line, bookmarks[0].column));
                    return;
                }
            } else {
                resolve(nextBookmark);
                return;
            }
        } else {
            // JUMP_BACKWARD
            for (let index = bookmarks.length - 1; index >= 0; index--) {
                const element = bookmarks[index];
                if (element.line < currentPosition.line) {
                    nextBookmark = new Position(element.line, element.column); // .line
                    break;
                }
            }
            if (typeof nextBookmark === "undefined") {
                if (navigateThroughAllFiles) {
                    resolve(NO_MORE_BOOKMARKS);
                    return;
                } else if (!wrapNavigation) {
                    resolve(NO_BOOKMARKS_BEFORE);
                    return;
                } else {
                    resolve(new Position(bookmarks[bookmarks.length - 1].line, bookmarks[bookmarks.length - 1].column));
                    return;
                }
            } else {
                resolve(nextBookmark);
                return;
            }
        }
    });
}

export function listBookmarks(file: File, workspaceFolder: WorkspaceFolder) {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve) => {
        // no bookmark, returns empty
        if (file.bookmarks.length === 0) {
            resolve(undefined);
            return;
        }

        let uriDocBookmark: Uri;
        if (file.uri) {
            uriDocBookmark = file.uri;
        } else {
            if (!workspaceFolder) {
                uriDocBookmark = Uri.file(file.path);
            } else {
                const prefix = workspaceFolder.uri.path.endsWith("/")
                    ? workspaceFolder.uri.path
                    : `${workspaceFolder.uri.path}/`;
                uriDocBookmark = uriWith(workspaceFolder.uri, prefix, file.path);
            }
        }

        // file does not exist, returns empty
        if (!(await uriExists(uriDocBookmark))) {
            resolve(undefined);
            return;
        }

        // const uriDocBookmark: Uri = Uri.file(file.path);
        workspace.openTextDocument(uriDocBookmark).then((doc) => {
            const items: BookmarkQuickPickItem[] = [];
            const invalids = [];
            for (let index = 0; index < file.bookmarks.length; index++) {
                const bookmarkLine = file.bookmarks[index].line + 1;
                const bookmarkColumn = file.bookmarks[index].column + 1;

                // check for 'invalidated' bookmarks, when its outside the document length
                if (bookmarkLine <= doc.lineCount) {
                    const lineText = doc.lineAt(bookmarkLine - 1).text.trim();
                    // const normalizedPath = doc.uri.fsPath;

                    if (file.bookmarks[index].label === "") {
                        items.push({
                            description: "(Ln " + bookmarkLine.toString() + ", Col " + bookmarkColumn.toString() + ")",
                            label: lineText,
                            detail: file.path,
                            uri: uriDocBookmark,
                        });
                    } else {
                        items.push({
                            description: "(Ln " + bookmarkLine.toString() + ", Col " + bookmarkColumn.toString() + ")",
                            label: codicons.tag + " " + file.bookmarks[index].label,
                            detail: file.path,
                            uri: uriDocBookmark,
                        });
                    }
                } else {
                    invalids.push(bookmarkLine);
                }
            }
            if (invalids.length > 0) {
                let idxInvalid: number;
                for (let indexI = 0; indexI < invalids.length; indexI++) {
                    idxInvalid = file.bookmarks.indexOf(<Bookmark>{ line: invalids[indexI] - 1 });
                    file.bookmarks.splice(idxInvalid, 1);
                }
            }

            resolve(items);
            return;
        });
    });
}

export function clear(file: File): void {
    file.bookmarks.length = 0;
}

export function indexOfBookmark(file: File, line: number): number {
    for (let index = 0; index < file.bookmarks.length; index++) {
        const element = file.bookmarks[index];
        if (element.line === line) {
            return index;
        }
    }

    return -1;
}

export async function getLinePreview(uri: Uri, line: number): Promise<string> {
    // const uriDocBookmark: Uri = Uri.file(file.path);
    const doc = await workspace.openTextDocument(uri);
    return doc.lineAt(line).text.trim();
}

export function sortBookmarks(bookmarks: Bookmark[]): void {
    bookmarks.sort((n1, n2) => {
        if (n1.line > n2.line) {
            return 1;
        }
        if (n1.line < n2.line) {
            return -1;
        }
        return 0;
    });
}
