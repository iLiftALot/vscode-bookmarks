/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import {
    DecorationOptions,
    DecorationRenderOptions,
    OverviewRulerLane,
    Range,
    TextEditor,
    TextEditorDecorationType,
    ThemeColor,
    Uri,
    window,
    workspace
} from "vscode";
import { createLineDecoration } from "vscode-ext-decoration";
import { Bookmark } from "../core/bookmark";
import { Controller } from "../core/controller";
import { indexOfBookmark } from "../core/operations";
import { createBookmarkIconUri } from "../utils/bookmarkIcon";
import { getOverviewRulerLaneConfig } from "../utils/overviewRulerLane";

function createGutterRulerDecoration(
    overviewRulerLane?: OverviewRulerLane,
    overviewRulerColor?: string | ThemeColor,
    gutterIconPath?: string | Uri
): TextEditorDecorationType {
    const decorationOptions: DecorationRenderOptions = {
        gutterIconPath,
        overviewRulerLane,
        overviewRulerColor: overviewRulerLane !== undefined ? overviewRulerColor : undefined
    };

    decorationOptions.isWholeLine = false;

    return window.createTextEditorDecorationType(decorationOptions);
}

export function createBookmarkLabelInlineDecoration(): TextEditorDecorationType {
    const bookmarksLabelInlineMargin = workspace.getConfiguration("bookmarks").get("label.inline.margin", 2);
    const labelInlineFontStyle = workspace.getConfiguration("bookmarks").get("label.inline.fontStyle", "normal");
    const bookmarksLabelInlineFontWeight = workspace.getConfiguration("bookmarks").get("label.inline.fontWeight", 400);

    const decorationOptions: DecorationRenderOptions = {
        after: {
            fontStyle: labelInlineFontStyle,
            color: new ThemeColor("bookmarks.labelInlineMessageTextColor"),
            backgroundColor: new ThemeColor("bookmarks.labelInlineMessageBackgroundColor"),
            textDecoration: `none;margin:0 0 0 ${bookmarksLabelInlineMargin}ch;`
                + `font-weight:${bookmarksLabelInlineFontWeight}`
        }
    };
    return window.createTextEditorDecorationType(decorationOptions);
}

export function createBookmarkDecorations(): TextEditorDecorationType[] {
    const iconPath = createBookmarkIconUri();
    const overviewRulerColor = new ThemeColor("bookmarks.overviewRuler");
    const lineBackground = new ThemeColor("bookmarks.lineBackground");
    const lineBorder = new ThemeColor("bookmarks.lineBorder");
    const overviewRulerLane = getOverviewRulerLaneConfig();
    const gutterDecoration = createGutterRulerDecoration(overviewRulerLane, overviewRulerColor, iconPath);
    const lineDecoration = createLineDecoration(lineBackground, lineBorder);
    return [ gutterDecoration, lineDecoration ];
}

function buildDecorationOptionsForInlineBookmarkLabel(
    activeEditor: TextEditor,
    bookmark: Bookmark
): DecorationOptions {
    const elementLineRange = activeEditor.document.lineAt(bookmark.line).range;
    const decorationOptionsForLabel: DecorationOptions = {
        range: new Range(
            elementLineRange.start.line,
            elementLineRange.end.character,
            elementLineRange.start.line,
            elementLineRange.end.character
        ),
        renderOptions: {
            after: {
                contentText: bookmark.label
            }
        }
    };

    return decorationOptionsForLabel;
}

export function updateDecorationsInActiveEditor(
    activeEditor: TextEditor | undefined,
    bookmarks: Controller,
    bookmarkDecorationType: TextEditorDecorationType[],
    bookmarkLabelInlineDecoration: TextEditorDecorationType
) {
    if (!activeEditor) {
        return;
    }

    if (!bookmarks.activeFile) {
        return;
    }

    if (bookmarks.activeFile.bookmarks.length === 0) {
        const bks: Range[] = [];

        bookmarkDecorationType.forEach((d) => activeEditor.setDecorations(d, bks));
        activeEditor.setDecorations(bookmarkLabelInlineDecoration, []);
        return;
    }

    const decorationRanges: Range[] = [];
    const decorationOptionsForLabels: DecorationOptions[] = [];

    const bookmarksLabelInlineEnabled = workspace.getConfiguration("bookmarks").get("label.inline.enabled", false);

    // Remove all bookmarks if active file is empty
    if (activeEditor.document.lineCount === 1 && activeEditor.document.lineAt(0).text === "") {
        bookmarks.activeFile.bookmarks = [];
    } else {
        const invalids = [];
        for (const bookmark of bookmarks.activeFile.bookmarks) {
            if (bookmark.line <= activeEditor.document.lineCount) {
                const decorationRange = new Range(bookmark.line, 0, bookmark.line, 0);
                decorationRanges.push(decorationRange);

                if (bookmarksLabelInlineEnabled && bookmark.label !== undefined && bookmark.label.length > 0) {
                    decorationOptionsForLabels.push(buildDecorationOptionsForInlineBookmarkLabel(
                        activeEditor,
                        bookmark
                    ));
                }
            } else {
                invalids.push(bookmark);
            }
        }

        if (invalids.length > 0) {
            let idxInvalid: number;
            for (const element of invalids) {
                idxInvalid = indexOfBookmark(bookmarks.activeFile, element.line);
                bookmarks.activeFile.bookmarks.splice(idxInvalid, 1);
            }
        }
    }
    // Add common decorations (gutter icons/line highlights)
    bookmarkDecorationType.forEach((d) => activeEditor.setDecorations(d, decorationRanges));
    // Add label inline text decorations
    activeEditor.setDecorations(bookmarkLabelInlineDecoration, decorationOptionsForLabels);
}
