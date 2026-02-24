/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position, l10n, window } from "vscode";
import { expandSelectionToPosition, selectLines, shrinkSelectionToPosition } from "vscode-ext-selection";
import { Directions } from "./core/constants";
import { nextBookmark } from "./core/operations";
import { Bookmark } from "./core/bookmark";
import { logger } from "./utils/logger";

export function selectBookmarkedLines(bookmarks: Bookmark[]) {
    if (!window.activeTextEditor) {
        window.showInformationMessage(l10n.t("Open a file first to clear bookmarks"));
        return;
    }

    if (bookmarks.length === 0) {
        window.showInformationMessage(l10n.t("No Bookmarks found"));
        return;
    }

    const lines: number[] = [];
    for (const bookmark of bookmarks) {
        lines.push(bookmark.line);
    }
    selectLines(window.activeTextEditor, lines);
}

export function shrinkSelection(bookmarks: Bookmark[]) {
    if (!window.activeTextEditor) {
        window.showInformationMessage(l10n.t("Open a file first to shrink bookmark selection"));
        return;
    }

    if (window.activeTextEditor.selections.length > 1) {
        window.showInformationMessage(l10n.t("Command not supported with more than one selection"));
        return;
    }

    if (window.activeTextEditor.selection.isEmpty) {
        window.showInformationMessage(l10n.t("No selection found"));
        return;
    }

    if (bookmarks.length === 0) {
        window.showInformationMessage(l10n.t("No Bookmarks found"));
        return;
    }

    // which direction?
    const direction: Directions = window.activeTextEditor.selection.isReversed
        ? Directions.Forward
        : Directions.Backward;
    const activeSelectionStartLine: number = window.activeTextEditor.selection.isReversed
        ? window.activeTextEditor.selection.end.line
        : window.activeTextEditor.selection.start.line;

    let currPosition: Position;
    if (direction === Directions.Forward) {
        currPosition = window.activeTextEditor.selection.start;
    } else {
        currPosition = window.activeTextEditor.selection.end;
    }

    nextBookmark(bookmarks, currPosition, direction)
        .then((next) => {
            if (typeof next === "number") {
                window.setStatusBarMessage(l10n.t("No more bookmarks"), 2000);
                return;
            } else {
                if (
                    (direction === Directions.Backward && next.line < activeSelectionStartLine) ||
                    (direction === Directions.Forward && next.line > activeSelectionStartLine)
                ) {
                    window.setStatusBarMessage(l10n.t("No more bookmarks to shrink"), 2000);
                } else {
                    shrinkSelectionToPosition(window.activeTextEditor, next, direction);
                }
            }
        })
        .catch((error) => {
            logger.error("selection.shrinkSelection", "nextBookmark rejected while shrinking selection", error);
        });
}

export function expandSelectionToNextBookmark(bookmarks: Bookmark[], direction: Directions) {
    if (!window.activeTextEditor) {
        window.showInformationMessage(l10n.t("Open a file first to clear bookmarks"));
        return;
    }

    if (bookmarks.length === 0) {
        window.showInformationMessage(l10n.t("No Bookmarks found"));
        return;
    }

    let currPosition: Position;
    if (window.activeTextEditor.selection.isEmpty) {
        currPosition = window.activeTextEditor.selection.active;
    } else {
        if (direction === Directions.Forward) {
            currPosition = window.activeTextEditor.selection.end;
        } else {
            currPosition = window.activeTextEditor.selection.start;
        }
    }

    nextBookmark(bookmarks, currPosition, direction)
        .then((next) => {
            if (typeof next === "number") {
                window.setStatusBarMessage(l10n.t("No more bookmarks"), 2000);
                return;
            } else {
                expandSelectionToPosition(window.activeTextEditor, next, direction);
            }
        })
        .catch((error) => {
            logger.error("selection.expandSelectionToNextBookmark", "nextBookmark rejected while expanding selection", error);
        });
}
