/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { Uri, commands } from "vscode";
import { File } from "../core/file";

export interface EditorLineNumberContextParams {
    lineNumber: number;
    uri: Uri;
}

export function updateLinesWithBookmarkContext(activeFile: File | undefined): void {
    const linesWithBookmarks = activeFile?.bookmarks.map((bookmark) => bookmark.line + 1) ?? [];

    void commands.executeCommand("setContext", "bookmarks.linesWithBookmarks", linesWithBookmarks);
}
