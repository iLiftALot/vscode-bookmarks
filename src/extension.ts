/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { Position, Selection, Tab, TabInputText, TextDocument, Uri, ViewColumn } from "vscode";
import { codicons } from "vscode-ext-codicons";
import { registerExport } from "./commands/export";
import { registerOpenSettings } from "./commands/openSettings";
import { registerSupportBookmarks } from "./commands/supportBookmarks";
import { registerWalkthrough } from "./commands/walkthrough";
import { Bookmark, BookmarkQuickPickItem } from "./core/bookmark";
import {
    Directions,
    isWindows,
    NO_BOOKMARKS_AFTER,
    NO_BOOKMARKS_BEFORE,
    NO_MORE_BOOKMARKS,
    SEARCH_EDITOR_SCHEME,
} from "./core/constants";
import { Container } from "./core/container";
import { Controller } from "./core/controller";
import { File } from "./core/file";
import { indexOfBookmark, listBookmarks, nextBookmark, sortBookmarks } from "./core/operations";
import {
    createBookmarkDecorations,
    createGlobalBookmarkDecorations,
    updateDecorationsInActiveEditor,
    updateGlobalDecorationsInActiveEditor,
} from "./decoration/decoration";
import { GlobalBookmarksExplorer } from "./global/globalBookmarkProvider";
import {
    GLOBAL_BOOKMARKS_KEY,
    GLOBAL_SIDEBAR_HIDE_POSITION,
    GLOBAL_VIEW_AS_LIST,
    GlobalBookmarksManager,
    GlobalFile,
} from "./global/globalBookmarks";
import { registerGutterCommands } from "./gutter/commands";
import { EditorLineNumberContextParams, updateLinesWithBookmarkContext } from "./gutter/editorLineNumberContext";
import { pickController } from "./quickpick/controllerPicker";
import { expandSelectionToNextBookmark, selectBookmarkedLines, shrinkSelection } from "./selections";
import { BookmarksExplorer } from "./sidebar/bookmarkProvider";
import { registerHelpAndFeedbackView } from "./sidebar/helpAndFeedbackView";
import { ViewAs } from "./sidebar/nodes";
import { parsePosition, Point } from "./sidebar/parser";
import { updateStickyBookmarks } from "./sticky/sticky";
import { Sticky } from "./sticky/stickyLegacy";
import { loadBookmarks, saveBookmarks } from "./storage/workspaceState";
import { suggestLabel, useSelectionWhenAvailable } from "./suggestion";
import { appendPath, getRelativePath } from "./utils/fs";
import { logger } from "./utils/logger";
import { isInDiffEditor, previewPositionInDocument, revealPosition } from "./utils/reveal";
import { registerWhatsNew } from "./whats-new/commands";

export async function activate(context: vscode.ExtensionContext) {
    Container.context = context;
    Container.globalState.setKeysForSync([
        GLOBAL_BOOKMARKS_KEY,
        GLOBAL_SIDEBAR_HIDE_POSITION,
        GLOBAL_VIEW_AS_LIST,
    ] as const);

    logger.initialize(context);
    logger.debug("extension.activate", "Activation started.", {
        extensionId: context.extension.id,
        extensionPath: context.extension.extensionPath,
        extensionUri: context.extension.extensionUri.toJSON(),
        extensionVersion: context.extension.packageJSON.version,
        vscodeVersion: vscode.version,
        platform: process.platform,
        configuration: JSON.stringify(vscode.workspace.getConfiguration("bookmarks"), null, 2),
    });

    let activeController: Controller;
    let controllers: Controller[] = [];
    let activeEditorCountLine: number;
    let timeout = null;

    let saveBookmarksInProjectSetting = vscode.workspace
        .getConfiguration("bookmarks")
        .get<boolean>("saveBookmarksInProject", false);

    await registerWhatsNew();
    await registerWalkthrough();

    context.subscriptions.push(
        vscode.commands.registerCommand("_bookmarks.openFolderWelcome", () => {
            const openFolderCommand = isWindows
                ? "workbench.action.files.openFolder"
                : "workbench.action.files.openFileFolder";
            vscode.commands.executeCommand(openFolderCommand);
        }),
    );

    // load pre-saved bookmarks
    await loadWorkspaceState();
    Container.workspaceManager = activeController;

    registerOpenSettings();
    registerSupportBookmarks();
    registerExport(() => controllers);
    registerHelpAndFeedbackView(context);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (cfg) => {
            // Allow change the gutterIcon without reload
            if (
                cfg.affectsConfiguration("bookmarks.gutterIconFillColor") ||
                cfg.affectsConfiguration("bookmarks.gutterIconBorderColor") ||
                cfg.affectsConfiguration("bookmarks.overviewRulerLane")
            ) {
                if (bookmarkDecorationType.length > 0) {
                    bookmarkDecorationType.forEach((b) => b.dispose());
                }

                bookmarkDecorationType = createBookmarkDecorations();
                context.subscriptions.push(...bookmarkDecorationType);

                updateDecorations();
                bookmarkProvider.refresh();
            }

            if (
                cfg.affectsConfiguration("bookmarks.gutterGlobalIconFillColor") ||
                cfg.affectsConfiguration("bookmarks.gutterGlobalIconBorderColor")
            ) {
                if (globalBookmarkDecorationType.length > 0) {
                    globalBookmarkDecorationType.forEach((b) => b.dispose());
                }

                globalBookmarkDecorationType = createGlobalBookmarkDecorations();
                context.subscriptions.push(...globalBookmarkDecorationType);

                updateDecorations();
                globalBookmarksExplorer.getProvider().refresh();
            }

            if (cfg.affectsConfiguration("bookmarks.saveBookmarksInProject")) {
                const newSaveBookmarksInProjectSetting = vscode.workspace
                    .getConfiguration("bookmarks")
                    .get<boolean>("saveBookmarksInProject", false);

                const changedFromFalseToTrue = !saveBookmarksInProjectSetting && newSaveBookmarksInProjectSetting;
                saveBookmarksInProjectSetting = newSaveBookmarksInProjectSetting;

                if (
                    changedFromFalseToTrue &&
                    vscode.workspace.workspaceFolders &&
                    vscode.workspace.workspaceFolders.length > 0
                ) {
                    let hasAnyBookmarksFile = false;
                    let mostRecentMtime: number | undefined;
                    const isSingleWorkspace = vscode.workspace.workspaceFolders.length === 1;

                    // Check all workspace folders to find if bookmarks.json exists
                    // For multi-root, track the most recent modification time
                    for (const workspaceFolder of vscode.workspace.workspaceFolders) {
                        const bookmarksFileInProject = appendPath(
                            appendPath(workspaceFolder.uri, ".vscode"),
                            "bookmarks.json",
                        );
                        try {
                            const stat = await vscode.workspace.fs.stat(bookmarksFileInProject);
                            hasAnyBookmarksFile = true;
                            if (mostRecentMtime === undefined || stat.mtime > mostRecentMtime) {
                                mostRecentMtime = stat.mtime;
                            }
                            // For single workspace, we can break after finding the file
                            if (isSingleWorkspace) {
                                break;
                            }
                        } catch (error) {
                            // It is expected that the bookmarks file might not exist in a workspace;
                            // ignore "FileNotFound" errors but log any other unexpected errors.
                            if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") {
                                logger.error("workspace", "Error while checking for project bookmarks file", error);
                            }
                        }
                    }

                    if (hasAnyBookmarksFile && mostRecentMtime !== undefined) {
                        const loadOption = vscode.l10n.t("Load bookmarks from project");
                        const message = vscode.l10n.t(
                            "A local copy of bookmarks was found in the project. Do you want to load?",
                        );
                        const mostRecentModificationLabel = new Date(mostRecentMtime).toLocaleString();

                        // Different messages for single vs multi-root workspaces
                        const detailMessage = isSingleWorkspace
                            ? vscode.l10n.t("The project's file was last modified at {0}", mostRecentModificationLabel)
                            : vscode.l10n.t(
                                  "One of the projects in the workspace has a bookmarks file. The most recent was modified at {0}",
                                  mostRecentModificationLabel,
                              );

                        const selection = await vscode.window.showInformationMessage(
                            message,
                            { modal: true, detail: detailMessage },
                            loadOption,
                        );

                        if (selection === loadOption) {
                            const oldControllers = controllers.slice();
                            await loadWorkspaceState();
                            Container.workspaceManager = activeController;
                            for (const controller of oldControllers) {
                                const disposable = controller as unknown as { dispose?: () => void };
                                if (typeof disposable.dispose === "function") {
                                    disposable.dispose();
                                }
                            }
                            bookmarkExplorer.updateControllers(controllers);
                            if (vscode.window.activeTextEditor) {
                                if (ensureActiveFile(vscode.window.activeTextEditor.document)) {
                                    updateDecorations();
                                    updateLinesWithBookmarkContext(activeController.activeFile);
                                }
                            }
                            return;
                        }

                        // cancelled: fall through to default handling below without changing controllers
                    }
                }

                splitOrMergeFilesInMultiRootControllers();
                saveWorkspaceState();
            }

            if (cfg.affectsConfiguration("bookmarks.sideBar.countBadge")) {
                bookmarkExplorer.updateBadge();
            }

            if (cfg.affectsConfiguration("bookmarks.sideBar.hideWelcome")) {
                toggleSideBarWelcomeVisibility();
            }
        }),
    );

    let bookmarkDecorationType = createBookmarkDecorations();
    context.subscriptions.push(...bookmarkDecorationType);

    let globalBookmarkDecorationType = createGlobalBookmarkDecorations();
    context.subscriptions.push(...globalBookmarkDecorationType);

    // Connect it to the Editors Events
    let activeEditor = vscode.window.activeTextEditor;

    if (activeEditor) {
        if (ensureActiveFile(activeEditor.document)) {
            activeEditorCountLine = activeEditor.document.lineCount;
            triggerUpdateDecorations();
            updateLinesWithBookmarkContext(activeController.activeFile);
        } else {
            logger.warn("extension.activate", "Unable to initialize active file during activation", {
                uri: activeEditor.document.uri.toString(),
                controllers: controllers.length,
            });
        }
    }

    const bookmarkExplorer = new BookmarksExplorer(controllers);
    const bookmarkProvider = bookmarkExplorer.getProvider();

    bookmarkExplorer.updateBadge();

    // ==========================================
    // --- Global Bookmarks ---
    // ==========================================
    const globalBookmarksManager = new GlobalBookmarksManager();
    globalBookmarksManager.load();
    const globalBookmarksExplorer = new GlobalBookmarksExplorer(globalBookmarksManager);
    globalBookmarksExplorer.updateBadge();
    Container.globalManager = globalBookmarksManager;
    context.subscriptions.push({
        dispose: () => {
            globalBookmarksManager.dispose();
            globalBookmarksExplorer.dispose();
        },
    });

    toggleSideBarWelcomeVisibility();

    vscode.commands.registerCommand("_bookmarks.sidebar.hidePosition", () => toggleSidebarPositionVisibility(false));
    vscode.commands.registerCommand("_bookmarks.sidebar.showPosition", () => toggleSidebarPositionVisibility(true));
    vscode.commands.executeCommand(
        "setContext",
        "bookmarks.isHidingPosition",
        Container.globalState.get(GLOBAL_SIDEBAR_HIDE_POSITION, false),
    );

    function toggleSideBarWelcomeVisibility() {
        vscode.commands.executeCommand(
            "setContext",
            "bookmarks.isHidingWelcome",
            vscode.workspace.getConfiguration("bookmarks").get("sideBar.hideWelcome", false),
        );
    }

    function toggleSidebarPositionVisibility(visible: boolean) {
        vscode.commands.executeCommand("setContext", "bookmarks.isHidingPosition", !visible);
        Container.globalState.update(GLOBAL_SIDEBAR_HIDE_POSITION, !visible);
        bookmarkProvider.refresh();
    }

    const viewAsList = Container.globalState.get(GLOBAL_VIEW_AS_LIST, false);
    vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", viewAsList);
    vscode.commands.registerCommand("_bookmarks.viewAsTree#sideBar", () => toggleViewAs(ViewAs.VIEW_AS_TREE));
    vscode.commands.registerCommand("_bookmarks.viewAsList#sideBar", () => toggleViewAs(ViewAs.VIEW_AS_LIST));
    function toggleViewAs(view: ViewAs) {
        if (view === ViewAs.VIEW_AS_LIST) {
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", true);
        } else {
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", false);
        }
        Container.globalState.update(GLOBAL_VIEW_AS_LIST, view === ViewAs.VIEW_AS_LIST);
        bookmarkProvider.refresh();
    }

    vscode.window.onDidChangeActiveTextEditor(
        (editor) => {
            activeEditor = editor;
            if (editor) {
                if (ensureActiveFile(editor.document)) {
                    activeEditorCountLine = editor.document.lineCount;
                    triggerUpdateDecorations();
                    updateLinesWithBookmarkContext(activeController.activeFile);
                }
            }
        },
        null,
        context.subscriptions,
    );

    vscode.workspace.onDidChangeTextDocument(
        (event) => {
            if (activeEditor && event.document === activeEditor.document) {
                // triggerUpdateDecorations();
                let updatedBookmark = false;

                // workaround for formatters like Prettier (#118)
                if (vscode.workspace.getConfiguration("bookmarks").get("useWorkaroundForFormatters", false)) {
                    logger.debug(
                        "extension.onDidChangeTextDocument",
                        "Triggering decorations update with delay due to formatter workaround setting",
                    );
                    updateDecorations();
                    return;
                }

                // call sticky function when the activeEditor is changed
                if (activeController.activeFile && activeController.activeFile.bookmarks.length > 0) {
                    if (
                        vscode.workspace
                            .getConfiguration("bookmarks")
                            .get<boolean>("experimental.enableNewStickyEngine", true)
                    ) {
                        logger.debug("extension.onDidChangeTextDocument", "Using new sticky engine");
                        updatedBookmark = updateStickyBookmarks(
                            event,
                            activeController.activeFile,
                            activeEditor,
                            activeController,
                        );
                    } else {
                        logger.debug("extension.onDidChangeTextDocument", "Using old sticky engine");
                        updatedBookmark = Sticky.stickyBookmarks(
                            event,
                            activeEditorCountLine,
                            activeController.activeFile,
                            activeEditor,
                            activeController,
                        );
                    }
                }

                // Sticky global bookmarks — keep them in sync with line changes
                const globalFile = globalBookmarksManager.fromUri(event.document.uri);
                if (globalFile && globalFile.bookmarks.length > 0) {
                    const globalUpdated = updateStickyGlobalBookmarks(
                        event,
                        globalFile,
                        activeEditor,
                        globalBookmarksManager,
                    );
                    if (globalUpdated) {
                        globalBookmarksManager.notifyAndSave();
                    }
                }

                activeEditorCountLine = event.document.lineCount;
                updateDecorations();

                if (updatedBookmark) {
                    saveWorkspaceState();
                }
            }
        },
        null,
        context.subscriptions,
    );

    // Handle file renames
    context.subscriptions.push(
        vscode.workspace.onDidRenameFiles(async (rename) => {
            if (rename.files.length === 0) {
                return;
            }

            for (const file of rename.files) {
                const files = activeController.files.map((file) => file.path);
                const stat = await vscode.workspace.fs.stat(file.newUri);

                const fileRelativeOldPath = getRelativePath(
                    activeController.workspaceFolder.uri.path,
                    file.oldUri.path,
                );
                const fileRelativeNewPath = getRelativePath(
                    activeController.workspaceFolder.uri.path,
                    file.newUri.path,
                );

                if (stat.type === vscode.FileType.File) {
                    if (files.includes(fileRelativeOldPath)) {
                        activeController.updateFilePath(fileRelativeOldPath, fileRelativeNewPath);
                    }
                }
                if (stat.type === vscode.FileType.Directory) {
                    activeController.updateDirectoryPath(fileRelativeOldPath, fileRelativeNewPath);
                }
            }

            bookmarkProvider.refresh();
            saveWorkspaceState();
            if (activeEditor) {
                activeController.activeFile = activeController.fromUri(activeEditor.document.uri);
                updateDecorations();
            }
        }),
    );

    // Timeout
    function triggerUpdateDecorations() {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(updateDecorations, 100);
    }

    // Update the active editor decorations
    function updateDecorations() {
        updateDecorationsInActiveEditor(activeEditor, activeController, bookmarkDecorationType);
        updateGlobalDecorationsInActiveEditor(activeEditor, globalBookmarksManager, globalBookmarkDecorationType);
    }

    updateDecorations();

    // Refresh global gutter decorations whenever global bookmarks change
    globalBookmarksManager.onDidChange(() => {
        updateGlobalDecorationsInActiveEditor(
            vscode.window.activeTextEditor,
            globalBookmarksManager,
            globalBookmarkDecorationType,
        );
    });

    function getActiveFileBookmarks(): Bookmark[] {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc) {
            logger.debug("extension.bookmarks.expandSelectionToNext", "No active document found");
            return [];
        }

        if (!ensureActiveFile(doc)) {
            logger.debug("extension.getActiveFileBookmarks", "No active controller/file available");
            return [];
        }
        const activeFile = activeController.activeFile;

        if (!activeFile) {
            logger.debug("extension.getActiveFileBookmarks", "No active file available while resolving bookmarks");
            return [];
        }

        const resolvedUri = doc.uri ?? activeFile.uri ?? activeController.getFileUri(activeFile);
        if (!resolvedUri) {
            logger.warn("extension.getActiveFileBookmarks", "Could not resolve URI for active file", {
                filePath: activeFile.path,
            });
            return [...activeFile.bookmarks].sort((a, b) => a.line - b.line);
        }

        const globalFile = globalBookmarksManager.fromUri(resolvedUri);
        const sortedBookmarks = [...activeFile.bookmarks, ...(globalFile?.bookmarks || [])].sort(
            (a, b) => a.line - b.line,
        );
        logger.debug("extension.getActiveFileBookmarks", "Resolved bookmarks for active file", {
            filePath: activeFile.path,
            uri: resolvedUri.toString(),
            activeFileBookmarks: activeFile.bookmarks.length,
            globalFileBookmarks: globalFile?.bookmarks.length || 0,
            totalBookmarks: sortedBookmarks.length,
        });
        return sortedBookmarks;
    }

    vscode.commands.registerCommand("_bookmarks.jumpTo", (documentPath, line, column: string, uri: Uri) => {
        vscode.workspace.openTextDocument(uri).then((doc) => {
            vscode.window.showTextDocument(doc).then(() => {
                const lineInt: number = parseInt(line, 10);
                const columnInt: number = parseInt(column, 10);
                revealPosition(lineInt - 1, columnInt - 1);
            });
        });
    });

    registerGutterCommands(toggle, toggleLabeled);

    vscode.commands.registerCommand("bookmarks.refresh", () => {
        bookmarkProvider.refresh();
    });

    vscode.commands.registerCommand("_bookmarks.search#sideBar", () => {
        listFromAllFiles();
    });

    vscode.commands.registerCommand("_bookmarks.addBookmark#sideBar", async () => {
        // Validate if there is an open file in the editor
        if (!vscode.window.activeTextEditor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to add bookmarks"));
            return;
        }

        if (vscode.window.activeTextEditor.document.uri.scheme === SEARCH_EDITOR_SCHEME) {
            vscode.window.showInformationMessage(vscode.l10n.t("You can't add bookmarks in Search Editor"));
            return;
        }

        // Ensure activeFile is initialized
        if (!activeController?.activeFile) {
            if (!ensureActiveFile(vscode.window.activeTextEditor.document)) {
                return;
            }
        }

        const currentPosition = vscode.window.activeTextEditor.selection.active;
        const index = indexOfBookmark(activeController.activeFile, currentPosition.line);

        // Scenario 1: No bookmark at current line -> add new bookmark
        if (index === -1) {
            await toggle();
            return;
        }

        const bookmark = activeController.activeFile.bookmarks[index];

        // Scenario 2: Regular bookmark found -> show information message
        if (!bookmark.label || bookmark.label === "") {
            vscode.window.showInformationMessage(vscode.l10n.t("There is already a bookmark at this line"));
            return;
        }

        // Scenario 3: Labeled bookmark found -> edit the label
        const position: vscode.Position = new vscode.Position(currentPosition.line, currentPosition.character);
        const suggestedLabel = bookmark.label;
        askForBookmarkLabel(index, position, suggestedLabel, false, activeController.activeFile);
    });

    vscode.commands.registerCommand("_bookmarks.clearFromFile", async (node) => {
        // Check if we should confirm before clearing (this is from Side Bar)
        const shouldProceed = await shouldConfirmClear("sideBar");
        if (!shouldProceed) {
            return;
        }

        activeController.clear(node.bookmark);
        saveWorkspaceState();
        updateDecorations();
    });

    vscode.commands.registerCommand("_bookmarks.deleteBookmark", (node) => {
        const book: File = activeController.fromUri(node.command.arguments[3]);
        const index = indexOfBookmark(book, node.command.arguments[1] - 1);
        activeController.removeBookmark(index, node.command.arguments[1] - 1, book);
        saveWorkspaceState();
        updateDecorations();
    });

    vscode.commands.registerCommand("_bookmarks.editLabel", (node) => {
        const book: File = activeController.fromUri(node.command.arguments[3]);
        const index = indexOfBookmark(book, node.command.arguments[1] - 1);

        const position: vscode.Position = new vscode.Position(
            node.command.arguments[1] - 1,
            node.command.arguments[2] - 1,
        );
        const suggestedLabel = book.bookmarks[index].label || node.label;
        askForBookmarkLabel(index, position, suggestedLabel, false, book);
    });

    vscode.commands.registerCommand("bookmarks.clear", () => clear("commandPalette"));
    vscode.commands.registerCommand("bookmarks.clearFromAllFiles", () => clearFromAllFiles());
    vscode.commands.registerCommand("_bookmarks.clearFromAllFiles#sideBar", () => clearFromAllFiles());
    vscode.commands.registerCommand("bookmarks.selectLines", () => {
        const fileBookmarks = getActiveFileBookmarks();
        selectBookmarkedLines(fileBookmarks);
    });
    vscode.commands.registerCommand("bookmarks.expandSelectionToNext", () => {
        const fileBookmarks = getActiveFileBookmarks();
        expandSelectionToNextBookmark(fileBookmarks, Directions.Forward);
    });
    vscode.commands.registerCommand("bookmarks.expandSelectionToPrevious", () => {
        const fileBookmarks = getActiveFileBookmarks();
        expandSelectionToNextBookmark(fileBookmarks, Directions.Backward);
    });
    vscode.commands.registerCommand("bookmarks.shrinkSelection", () => {
        const fileBookmarks = getActiveFileBookmarks();
        shrinkSelection(fileBookmarks);
    });
    vscode.commands.registerCommand("bookmarks.toggle", () => toggle());
    vscode.commands.registerCommand("bookmarks.toggleLabeled", () => toggleLabeled());
    vscode.commands.registerCommand("bookmarks.jumpToNext", () => jumpToNext(Directions.Forward));
    vscode.commands.registerCommand("bookmarks.jumpToPrevious", () => jumpToNext(Directions.Backward));
    vscode.commands.registerCommand("bookmarks.list", () => list());
    vscode.commands.registerCommand("bookmarks.listFromAllFiles", () => listFromAllFiles());

    // ==========================================
    // --- Global Bookmark Commands ---
    // ==========================================

    vscode.commands.registerCommand(
        "_bookmarks.jumpToGlobal",
        (filePath: string, line: string, column: string, uri: Uri) => {
            vscode.workspace.openTextDocument(uri).then((doc) => {
                vscode.window.showTextDocument(doc).then(() => {
                    const lineInt: number = parseInt(line, 10);
                    const columnInt: number = parseInt(column, 10);
                    revealPosition(lineInt, columnInt);
                });
            });
        },
    );

    vscode.commands.registerCommand("_bookmarks.refreshGlobal", () => {
        globalBookmarksExplorer.getProvider().refresh();
    });

    vscode.commands.registerCommand("bookmarks.toggleGlobal", async () => {
        if (!vscode.window.activeTextEditor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to toggle global bookmarks"));
            return;
        }

        if (vscode.window.activeTextEditor.document.uri.scheme === SEARCH_EDITOR_SCHEME) {
            vscode.window.showInformationMessage(vscode.l10n.t("You can't toggle global bookmarks in Search Editor"));
            return;
        }

        const uri = vscode.window.activeTextEditor.document.uri;
        const selections = vscode.window.activeTextEditor.selections;
        const toggleMode = vscode.workspace
            .getConfiguration("bookmarks")
            .get<string>("multicursor.toggleMode", "allLinesAtOnce");

        // Decide toggle state for allLinesAtOnce mode
        let forceState: "on" | "off" | undefined;
        if (toggleMode === "allLinesAtOnce" && selections.length > 1) {
            const file = globalBookmarksManager.fromUri(uri);
            const allBookmarked =
                file && selections.every((sel) => globalBookmarksManager.indexOfBookmark(file, sel.active.line) >= 0);
            forceState = allBookmarked ? "off" : "on";
        }

        const toggledLines: number[] = [];
        for (const sel of selections) {
            const line = sel.active.line;
            if (toggledLines.includes(line)) continue;
            toggledLines.push(line);

            if (forceState === "on") {
                const file = globalBookmarksManager.fromUri(uri);
                if (!file || globalBookmarksManager.indexOfBookmark(file, line) < 0) {
                    await globalBookmarksManager.addBookmark(uri, line, sel.active.character);
                }
            } else if (forceState === "off") {
                const file = globalBookmarksManager.fromUri(uri);
                if (file) {
                    const idx = globalBookmarksManager.indexOfBookmark(file, line);
                    if (idx >= 0) {
                        globalBookmarksManager.removeBookmark(file, idx, line);
                    }
                }
            } else {
                await globalBookmarksManager.toggle(uri, line, sel.active.character);
            }
        }
        globalBookmarksManager.notifyAndSave();
    });

    vscode.commands.registerCommand("bookmarks.toggleGlobalLabeled", async () => {
        if (!vscode.window.activeTextEditor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to toggle global bookmarks"));
            return;
        }

        if (vscode.window.activeTextEditor.document.uri.scheme === SEARCH_EDITOR_SCHEME) {
            vscode.window.showInformationMessage(vscode.l10n.t("You can't toggle global bookmarks in Search Editor"));
            return;
        }

        const uri = vscode.window.activeTextEditor.document.uri;
        const selections = vscode.window.activeTextEditor.selections;

        // For labeled toggle, use the first selection for label suggestion
        const firstLine = selections[0].active.line;

        // Check if bookmark already exists at first line
        const existingFile = globalBookmarksManager.fromUri(uri);
        const existingIndex = existingFile ? globalBookmarksManager.indexOfBookmark(existingFile, firstLine) : -1;
        const oldLabel = existingIndex >= 0 ? existingFile.bookmarks[existingIndex].label || "" : "";

        const suggestion = suggestLabel(vscode.window.activeTextEditor.selection);
        if (suggestion !== "" && useSelectionWhenAvailable()) {
            const toggledLines: number[] = [];
            for (const sel of selections) {
                const line = sel.active.line;
                if (toggledLines.includes(line)) continue;
                toggledLines.push(line);
                await globalBookmarksManager.toggle(uri, line, sel.active.character, suggestion);
            }
            globalBookmarksManager.notifyAndSave();
            return;
        }

        const ibo = <vscode.InputBoxOptions>{
            prompt: vscode.l10n.t("Global Bookmark Label"),
            placeHolder: vscode.l10n.t("Type a label for your global bookmark"),
            value: suggestion !== "" ? suggestion : oldLabel,
        };
        const label = await vscode.window.showInputBox(ibo);
        if (typeof label === "undefined") {
            return;
        }
        if (label === "" && oldLabel === "") {
            vscode.window.showWarningMessage(vscode.l10n.t("You must define a label for the global bookmark."));
            return;
        }
        const toggledLines: number[] = [];
        for (const sel of selections) {
            const line = sel.active.line;
            if (toggledLines.includes(line)) continue;
            toggledLines.push(line);
            await globalBookmarksManager.toggle(uri, line, sel.active.character, label);
        }
        globalBookmarksManager.notifyAndSave();
    });

    vscode.commands.registerCommand("bookmarks.listGlobals", async () => {
        if (!globalBookmarksManager.hasAnyBookmark()) {
            vscode.window.showInformationMessage(vscode.l10n.t("No global bookmarks found"));
            return;
        }

        const items: BookmarkQuickPickItem[] = [];
        const activeTextEditor = vscode.window.activeTextEditor;
        const currentPosition: Position = activeTextEditor?.selection.active;

        for (const file of globalBookmarksManager.files) {
            if (file.bookmarks.length === 0) continue;
            const uri = Uri.file(file.path);
            for (const bkm of file.bookmarks) {
                let lineText: string;
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    lineText = doc.lineAt(bkm.line).text.trim();
                } catch {
                    lineText = `Line ${bkm.line + 1}`;
                }

                const label = bkm.label && bkm.label !== "" ? codicons.tag + " " + bkm.label : lineText;

                items.push({
                    label,
                    description: "(Ln " + (bkm.line + 1) + ", Col " + (bkm.column + 1) + ")",
                    detail: file.path,
                    uri,
                });
            }
        }

        const options = <vscode.QuickPickOptions>{
            placeHolder: vscode.l10n.t("Type a line number or a piece of code to navigate to"),
            matchOnDescription: true,
            matchOnDetail: true,
            onDidSelectItem: (item) => {
                const itemT = <BookmarkQuickPickItem>item;
                const point: Point = parsePosition(itemT.description);
                if (point) {
                    previewPositionInDocument(point, itemT.uri);
                }
            },
        };

        const selection = await vscode.window.showQuickPick(items, options);
        if (typeof selection === "undefined") {
            if (activeTextEditor) {
                vscode.workspace.openTextDocument(activeTextEditor.document.uri).then((doc) => {
                    vscode.window.showTextDocument(doc).then(() => {
                        if (currentPosition) {
                            revealPosition(currentPosition.line, currentPosition.character);
                        }
                    });
                });
            }
            return;
        }

        const point: Point = parsePosition(selection.description);
        if (point) {
            const selItem = <BookmarkQuickPickItem>selection;
            vscode.workspace.openTextDocument(selItem.uri).then((doc) => {
                vscode.window.showTextDocument(doc).then(() => {
                    revealPosition(point.line - 1, point.column - 1);
                });
            });
        }
    });

    vscode.commands.registerCommand("bookmarks.clearAllGlobals", () => {
        globalBookmarksManager.clearAll();
    });

    vscode.commands.registerCommand("_bookmarks.deleteGlobalBookmark", async (node) => {
        if (!node || node.line === undefined) return;
        const uri = Uri.file(node.filePath);
        await globalBookmarksManager.toggle(uri, node.line, node.column);
    });

    vscode.commands.registerCommand("_bookmarks.editGlobalLabel", async (node) => {
        if (!node || node.line === undefined) return;
        const uri = Uri.file(node.filePath);
        const file = globalBookmarksManager.fromUri(uri);
        if (!file) return;
        const index = globalBookmarksManager.indexOfBookmark(file, node.line);
        if (index < 0) return;

        const currentLabel = file.bookmarks[index].label || "";
        const ibo = <vscode.InputBoxOptions>{
            prompt: vscode.l10n.t("Global Bookmark Label"),
            placeHolder: vscode.l10n.t("Type a label for your global bookmark"),
            value: currentLabel,
        };
        const newLabel = await vscode.window.showInputBox(ibo);
        if (typeof newLabel === "undefined") return;

        globalBookmarksManager.updateLabel(file, index, node.line, node.column, newLabel);
    });

    vscode.commands.registerCommand("_bookmarks.clearGlobalFromFile", (node) => {
        if (!node || !node.filePath) return;
        globalBookmarksManager.clearFile(node.filePath);
    });

    function updateStickyGlobalBookmarks(
        event: vscode.TextDocumentChangeEvent,
        globalFile: GlobalFile,
        editor: vscode.TextEditor,
        manager: GlobalBookmarksManager,
    ): boolean {
        if (event.contentChanges.length === 0) {
            return false;
        }

        let updated = false;
        const keepBookmarksOnLineDelete = vscode.workspace
            .getConfiguration("bookmarks")
            .get<boolean>("keepBookmarksOnLineDelete", false);

        for (const change of event.contentChanges) {
            const isAdd = change.text.includes("\n");
            const isDel = change.range.start.line < change.range.end.line;

            if (!isAdd && !isDel) {
                continue;
            }

            if (isAdd) {
                const numberOfLinesAdded = (change.text.match(/\n/g) || []).length;
                const eventLine = change.range.start.line;
                let eventChar = change.range.start.character;

                if (eventChar > 0) {
                    let text = editor.document.lineAt(eventLine).text;
                    text = text.replace(/\t/g, "").replace(/\s/g, "");
                    if (text === "") {
                        eventChar = 0;
                    }
                }

                for (let i = 0; i < globalFile.bookmarks.length; i++) {
                    const bkmLine = globalFile.bookmarks[i].line;
                    if ((bkmLine > eventLine && eventChar > 0) || (bkmLine >= eventLine && eventChar === 0)) {
                        manager.updateBookmarkLine(globalFile, i, bkmLine + numberOfLinesAdded);
                        updated = true;
                    }
                }
            }

            if (isDel) {
                // Remove bookmarks inside the deleted range
                for (let line = change.range.start.line; line < change.range.end.line; line++) {
                    const idx = manager.indexOfBookmark(globalFile, line);
                    if (idx > -1) {
                        if (keepBookmarksOnLineDelete) {
                            const hasAfter = manager.indexOfBookmark(globalFile, change.range.end.line) > -1;
                            if (!hasAfter) {
                                manager.updateBookmarkLine(globalFile, idx, change.range.end.line);
                            } else {
                                globalFile.bookmarks.splice(idx, 1);
                            }
                        } else {
                            globalFile.bookmarks.splice(idx, 1);
                        }
                        updated = true;
                    }
                }

                // Shift bookmarks after the deleted range up
                const numberOfLinesDeleted = change.range.end.line - change.range.start.line;
                for (let i = 0; i < globalFile.bookmarks.length; i++) {
                    const bkmLine = globalFile.bookmarks[i].line;
                    const eventLine = change.range.start.line;
                    let eventChar = change.range.start.character;

                    if (eventChar > 0) {
                        let text = editor.document.lineAt(eventLine).text;
                        text = text.replace(/\t/g, "").replace(/\s/g, "");
                        if (text === "") {
                            eventChar = 0;
                        }
                    }

                    if ((bkmLine > eventLine && eventChar > 0) || (bkmLine >= eventLine && eventChar === 0)) {
                        manager.updateBookmarkLine(globalFile, i, bkmLine - numberOfLinesDeleted);
                        updated = true;
                    }
                }
            }
        }

        return updated;
    }

    function getActiveController(document: TextDocument): void {
        if (controllers.length === 0) {
            activeController = undefined;
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

        // system files don't have workspace, so use the first one [0]
        if (!workspaceFolder) {
            activeController = controllers[0];
            return;
        }

        if (controllers.length === 1) {
            activeController = controllers[0];
            return;
        }

        activeController =
            controllers.find((ctrl) => ctrl.workspaceFolder?.uri?.toString() === workspaceFolder.uri.toString()) ??
            controllers.find((ctrl) => ctrl.workspaceFolder?.uri?.path === workspaceFolder.uri.path) ??
            controllers[0];

        if (!activeController) {
            logger.warn("extension.getActiveController", "Could not resolve active controller", {
                uri: document.uri.toString(),
                workspaceFolder: workspaceFolder.uri.toString(),
                controllers: controllers.length,
            });
        }
    }

    function ensureActiveFile(document: TextDocument): boolean {
        getActiveController(document);
        if (!activeController) {
            logger.error("extension.ensureActiveFile", "No active controller available", {
                uri: document.uri.toString(),
                controllers: controllers.length,
            });
            return false;
        }

        activeController.addFile(document.uri);
        activeController.activeFile = activeController.fromUri(document.uri);

        if (!activeController.activeFile) {
            logger.warn("extension.ensureActiveFile", "Failed to resolve active file from URI", {
                uri: document.uri.toString(),
                controllerWorkspace: activeController.workspaceFolder?.uri?.toString(),
            });
            return false;
        }

        return true;
    }

    function splitOrMergeFilesInMultiRootControllers(): void {
        //
        if (vscode.workspace.workspaceFolders.length < 2) {
            return;
        }

        //?? needs work
        const saveBookmarksInProject = vscode.workspace
            .getConfiguration("bookmarks")
            .get("saveBookmarksInProject", false);

        if (saveBookmarksInProject) {
            const validFiles = activeController.files.filter((file) => !file.path.startsWith(".."));
            activeController.files = [...validFiles];
        }
    }

    async function loadWorkspaceState(): Promise<void> {
        // no workspace, load as `undefined` and will always be from `workspaceState`
        if (!vscode.workspace.workspaceFolders) {
            const ctrl = await loadBookmarks(undefined);
            controllers.push(ctrl);
            activeController = ctrl;
            return;
        }

        // NOT `saveBookmarksInProject`
        if (!vscode.workspace.getConfiguration("bookmarks").get("saveBookmarksInProject", false)) {
            //if (vscode.workspace.workspaceFolders.length > 1) {
            // no matter how many workspaceFolders exists, will always load from [0] because even with
            // multi-root, there would be no way to load state from different folders
            const ctrl = await loadBookmarks(vscode.workspace.workspaceFolders[0]);
            controllers.push(ctrl);
            activeController = ctrl;
            return;
        }

        // `saveBookmarksInProject` TRUE
        // single or multi-root, will load from each `workspaceFolder`
        controllers = await Promise.all(
            vscode.workspace.workspaceFolders?.map(async (workspaceFolder) => {
                const ctrl = await loadBookmarks(workspaceFolder);
                return ctrl;
            }),
        );
        if (!activeController && controllers.length > 0) {
            activeController = controllers[0];
        }
    }

    function saveWorkspaceState(): void {
        // no workspace, there is only one `controller`, and will always be from `workspaceState`
        if (!vscode.workspace.workspaceFolders) {
            if (!activeController) {
                logger.warn("extension.saveWorkspaceState", "Skipping save: no active controller");
                return;
            }
            saveBookmarks(activeController);
            Container.workspaceManager = activeController;
            return;
        }

        // NOT `saveBookmarksInProject`, will load from `workspaceFolders[0]` - as before
        if (!vscode.workspace.getConfiguration("bookmarks").get("saveBookmarksInProject", false)) {
            // no matter how many workspaceFolders exists, will always save to [0] because even with
            // multi-root, there would be no way to save state to different folders
            if (!activeController) {
                logger.warn("extension.saveWorkspaceState", "Skipping save: no active controller");
                return;
            }
            saveBookmarks(activeController);
            Container.workspaceManager = activeController;
            return;
        }

        // `saveBookmarksInProject` TRUE
        // single or multi-root, will save to each `workspaceFolder`
        controllers.forEach((controller) => {
            saveBookmarks(controller);
        });
    }

    function list() {
        if (!vscode.window.activeTextEditor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to list bookmarks"));
            return;
        }

        // no active bookmark
        if (!activeController.activeFile) {
            vscode.window.showInformationMessage(vscode.l10n.t("No Bookmarks found"));
            return;
        }

        // no bookmark
        if (activeController.activeFile.bookmarks.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t("No Bookmarks found"));
            return;
        }

        // push the items
        const items: vscode.QuickPickItem[] = [];
        for (let index = 0; index < activeController.activeFile.bookmarks.length; index++) {
            const bookmarkLine = activeController.activeFile.bookmarks[index].line + 1;
            const bookmarkColumn = activeController.activeFile.bookmarks[index].column + 1;
            const lineText = vscode.window.activeTextEditor.document.lineAt(bookmarkLine - 1).text.trim();

            if (activeController.activeFile.bookmarks[index].label === "") {
                items.push({
                    description: "(Ln " + bookmarkLine.toString() + ", Col " + bookmarkColumn.toString() + ")",
                    label: lineText,
                });
            } else {
                items.push({
                    description: "(Ln " + bookmarkLine.toString() + ", Col " + bookmarkColumn.toString() + ")",
                    label: codicons.tag + " " + activeController.activeFile.bookmarks[index].label,
                });
            }
        }

        // pick one
        const currentPosition: Position = vscode.window.activeTextEditor.selection.active;
        const options = <vscode.QuickPickOptions>{
            placeHolder: vscode.l10n.t("Type a line number or a piece of code to navigate to"),
            matchOnDescription: true,
            // matchOnDetail: true,
            onDidSelectItem: (item) => {
                const itemT = <vscode.QuickPickItem>item;
                const point: Point = parsePosition(itemT.description);
                if (point) {
                    revealPosition(point.line - 1, point.column - 1);
                }
            },
        };

        vscode.window.showQuickPick(items, options).then((selection) => {
            if (typeof selection === "undefined") {
                revealPosition(currentPosition.line, currentPosition.character);
                return;
            }
            const itemT = <vscode.QuickPickItem>selection;
            const point: Point = parsePosition(itemT.description);
            if (point) {
                revealPosition(point.line - 1, point.column - 1);
            }
        });
    }

    async function shouldConfirmClear(source: "commandPalette" | "sideBar"): Promise<boolean> {
        const confirmClearSetting = vscode.workspace.getConfiguration("bookmarks").get<string>("confirmClear", "never");

        // Check if confirmation should be shown based on the setting
        if (confirmClearSetting === "never") {
            return true; // No confirmation needed, proceed with clear
        }

        if (confirmClearSetting === "always") {
            // Always show confirmation
        } else if (confirmClearSetting === "commandPalette" && source !== "commandPalette") {
            return true; // Confirmation only for command palette, this is not from command palette
        } else if (confirmClearSetting === "sideBar" && source !== "sideBar") {
            return true; // Confirmation only for side bar, this is not from side bar
        }

        // Show confirmation dialog
        const message = vscode.l10n.t("Are you sure you want to clear all bookmarks from this file?");
        const clearButton = vscode.l10n.t("Clear");

        const result = await vscode.window.showWarningMessage(message, { modal: true }, clearButton);

        return result === clearButton;
    }

    async function clear(source: "commandPalette" | "sideBar" = "commandPalette") {
        if (!vscode.window.activeTextEditor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to clear bookmarks"));
            return;
        }

        // Check if we should confirm before clearing
        const shouldProceed = await shouldConfirmClear(source);
        if (!shouldProceed) {
            return;
        }

        activeController.clear();
        saveWorkspaceState();
        updateDecorations();
    }

    async function clearFromAllFiles() {
        const controller = await pickController(controllers, activeController);
        if (!controller) {
            return;
        }

        // Show confirmation dialog for clearing all files
        const confirmClearSetting = vscode.workspace.getConfiguration("bookmarks").get<string>("confirmClear", "never");

        if (confirmClearSetting !== "never") {
            // Show confirmation unless set to "never" (sideBar and commandPalette settings don't apply here since this is always from command palette)
            if (confirmClearSetting === "always" || confirmClearSetting === "commandPalette") {
                const message = vscode.l10n.t("Are you sure you want to clear all bookmarks from all files?");
                const clearButton = vscode.l10n.t("Clear");

                const result = await vscode.window.showWarningMessage(message, { modal: true }, clearButton);

                if (result !== clearButton) {
                    return;
                }
            }
        }

        controller.clearAll();

        saveWorkspaceState();
        updateDecorations();
    }

    async function listFromAllFiles() {
        const controller = await pickController(controllers, activeController);
        if (!controller) {
            return;
        }

        // no bookmark
        if (!controller.hasAnyBookmark()) {
            vscode.window.showInformationMessage(vscode.l10n.t("No Bookmarks found"));
            return;
        }

        // push the items
        const items: BookmarkQuickPickItem[] = [];
        const activeTextEditor = vscode.window.activeTextEditor;
        const promisses = [];
        const currentPosition: Position = vscode.window.activeTextEditor?.selection.active;

        for (const bookmark of controller.files) {
            const pp = listBookmarks(bookmark, controller.workspaceFolder);
            promisses.push(pp);
        }

        Promise.all(promisses).then((values) => {
            for (const element of values) {
                if (element) {
                    for (const elementInside of element) {
                        if (
                            activeTextEditor &&
                            elementInside.detail.toString().toLocaleLowerCase() ===
                                getRelativePath(
                                    controller.workspaceFolder?.uri?.path,
                                    activeTextEditor.document.uri.path,
                                ).toLocaleLowerCase()
                        ) {
                            items.push({
                                label: elementInside.label,
                                description: elementInside.description,
                                uri: elementInside.uri,
                            });
                        } else {
                            items.push({
                                label: elementInside.label,
                                description: elementInside.description,
                                detail: elementInside.detail,
                                uri: elementInside.uri,
                            });
                        }
                    }
                }
            }

            // sort
            // - active document
            // - no octicon - document in same workspaceFolder
            // - with octicon 'file-submodules' - document in another workspaceFolder
            // - with octicon - 'file-directory' - document outside any workspaceFolder
            const itemsSorted: vscode.QuickPickItem[] = items.sort(function (
                a: vscode.QuickPickItem,
                b: vscode.QuickPickItem,
            ): number {
                if (!a.detail && !b.detail) {
                    return 0;
                }

                if (!a.detail && b.detail) {
                    return -1;
                }

                if (a.detail && !b.detail) {
                    return 1;
                }

                if (
                    a.detail.toString().indexOf(codicons.file_submodule + " ") === 0 &&
                    b.detail.toString().indexOf(codicons.file_directory + " ") === 0
                ) {
                    return -1;
                }

                if (
                    a.detail.toString().indexOf(codicons.file_directory + " ") === 0 &&
                    b.detail.toString().indexOf(codicons.file_submodule + " ") === 0
                ) {
                    return 1;
                }

                if (
                    a.detail.toString().indexOf(codicons.file_submodule + " ") === 0 &&
                    b.detail.toString().indexOf(codicons.file_submodule + " ") === -1
                ) {
                    return 1;
                }

                if (
                    a.detail.toString().indexOf(codicons.file_submodule + " ") === -1 &&
                    b.detail.toString().indexOf(codicons.file_submodule + " ") === 0
                ) {
                    return -1;
                }

                if (
                    a.detail.toString().indexOf(codicons.file_directory + " ") === 0 &&
                    b.detail.toString().indexOf(codicons.file_directory + " ") === -1
                ) {
                    return 1;
                }

                if (
                    a.detail.toString().indexOf(codicons.file_directory + " ") === -1 &&
                    b.detail.toString().indexOf(codicons.file_directory + " ") === 0
                ) {
                    return -1;
                }

                return 0;
            });

            const options = <vscode.QuickPickOptions>{
                placeHolder: vscode.l10n.t("Type a line number or a piece of code to navigate to"),
                matchOnDescription: true,
                onDidSelectItem: (item) => {
                    const itemT = <BookmarkQuickPickItem>item;

                    let fileUri: Uri;
                    if (!itemT.detail) {
                        fileUri = activeTextEditor.document.uri;
                    } else {
                        fileUri = itemT.uri;
                    }

                    const point: Point = parsePosition(itemT.description);
                    if (
                        vscode.window.activeTextEditor &&
                        vscode.window.activeTextEditor.document.uri.fsPath.toLowerCase() ===
                            fileUri.fsPath.toLowerCase()
                    ) {
                        if (point) {
                            revealPosition(point.line - 1, point.column - 1);
                        }
                    } else {
                        previewPositionInDocument(point, fileUri);
                    }
                },
            };
            vscode.window.showQuickPick(itemsSorted, options).then((selection) => {
                if (typeof selection === "undefined") {
                    if (!activeTextEditor) {
                        vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                        return;
                    } else {
                        vscode.workspace.openTextDocument(activeTextEditor.document.uri).then((doc) => {
                            vscode.window.showTextDocument(doc).then(() => {
                                revealPosition(currentPosition.line, currentPosition.character);
                                return;
                            });
                        });
                    }
                }

                if (typeof selection === "undefined") {
                    return;
                }

                const point: Point = parsePosition(selection.description);
                if (!selection.detail) {
                    if (point) {
                        revealPosition(point.line - 1, point.column - 1);
                    }
                }
            });
        });
    }

    function jumpToNext(direction: Directions) {
        if (!vscode.window.activeTextEditor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to jump to bookmarks"));
            return;
        }

        if (!ensureActiveFile(vscode.window.activeTextEditor.document)) {
            return;
        }

        const activeFile = activeController.activeFile;
        if (!activeFile) {
            return;
        }

        const sortedBookmarks = getActiveFileBookmarks();

        nextBookmark(sortedBookmarks, vscode.window.activeTextEditor.selection.active, direction)
            .then((next) => {
                if (typeof next === "number") {
                    if (!checkBookmarks(next)) {
                        return;
                    }

                    activeController
                        .nextDocumentWithBookmarks(activeFile, direction)
                        .then((nextDocument) => {
                            if (nextDocument === NO_MORE_BOOKMARKS) {
                                return;
                            }

                            let uriDocument: Uri;
                            if (typeof nextDocument === "string") {
                                uriDocument = !activeController.workspaceFolder
                                    ? Uri.file(nextDocument.toString())
                                    : appendPath(activeController.workspaceFolder.uri, nextDocument.toString());
                            } else {
                                uriDocument = <Uri>nextDocument;
                            }

                            // same document?
                            //   const activeDocument = getRelativePath(activeController.workspaceFolder?.uri?.path, vscode.window.activeTextEditor.document.uri.fsPath);
                            //   if (nextDocument.toString() === activeDocument) {
                            if (uriDocument.fsPath === vscode.window.activeTextEditor.document.uri.fsPath) {
                                const bookmarkIndex =
                                    direction === Directions.Forward ? 0 : activeFile.bookmarks.length - 1;
                                revealPosition(
                                    activeFile.bookmarks[bookmarkIndex].line,
                                    activeFile.bookmarks[bookmarkIndex].column,
                                );
                            } else {
                                // const uriDocument = !activeController.workspaceFolder
                                //     ? Uri.file(nextDocument.toString())
                                //     : appendPath(activeController.workspaceFolder.uri, nextDocument.toString());
                                const tabGroupColumn = findTabGroupColumn(
                                    uriDocument,
                                    vscode.window.activeTextEditor.viewColumn,
                                );

                                vscode.workspace.openTextDocument(uriDocument).then((doc) => {
                                    vscode.window.showTextDocument(doc, tabGroupColumn).then(() => {
                                        const bookmarkIndex =
                                            direction === Directions.Forward ? 0 : activeFile.bookmarks.length - 1;
                                        revealPosition(
                                            activeFile.bookmarks[bookmarkIndex].line,
                                            activeFile.bookmarks[bookmarkIndex].column,
                                        );
                                    });
                                });
                            }
                        })
                        .catch(checkBookmarks);
                } else {
                    revealPosition(next.line, next.character);
                }
            })
            .catch((error) => {
                logger.error("extension.nextBookmark", "nextBookmark rejected", error);
            });
    }

    function findTabGroupColumn(uri: Uri, column: ViewColumn): ViewColumn {
        if (vscode.window.tabGroups.all.length === 1) {
            return column;
        }

        for (const tab of vscode.window.tabGroups.activeTabGroup.tabs) {
            if (isTabOfUri(tab, uri)) {
                return tab.group.viewColumn;
            }
        }

        for (const tabGroup of vscode.window.tabGroups.all) {
            if (tabGroup.viewColumn === column) continue;

            for (const tab of tabGroup.tabs) {
                if (isTabOfUri(tab, uri)) {
                    return tab.group.viewColumn;
                }
            }
        }

        return column;
    }

    function isTabOfUri(tab: Tab, uri: Uri): boolean {
        return (
            tab.input instanceof TabInputText &&
            tab.input.uri.fsPath.toLocaleLowerCase() === uri.fsPath.toLocaleLowerCase()
        );
    }

    function checkBookmarks(result: number | vscode.Position): boolean {
        if (result === NO_BOOKMARKS_BEFORE || result === NO_BOOKMARKS_AFTER) {
            if (vscode.workspace.getConfiguration("bookmarks").get("showNoMoreBookmarksWarning", true)) {
                vscode.window.showInformationMessage(vscode.l10n.t("No more bookmarks"));
            }
            return false;
        }
        return true;
    }

    function askForBookmarkLabel(
        index: number,
        position: vscode.Position,
        oldLabel?: string,
        jumpToPosition?: boolean,
        book?: File,
    ) {
        const ibo = <vscode.InputBoxOptions>{
            prompt: vscode.l10n.t("Bookmark Label"),
            placeHolder: vscode.l10n.t("Type a label for your bookmark"),
            value: oldLabel,
        };
        vscode.window.showInputBox(ibo).then((bookmarkLabel) => {
            if (typeof bookmarkLabel === "undefined") {
                return;
            }
            // 'empty'
            if (bookmarkLabel === "" && oldLabel === "") {
                vscode.window.showWarningMessage(vscode.l10n.t("You must define a label for the bookmark."));
                return;
            }
            if (index >= 0) {
                activeController.removeBookmark(index, position.line, book);
            }
            activeController.addBookmark(position, bookmarkLabel, book);

            // toggle editing mode
            if (jumpToPosition) {
                vscode.window.showTextDocument(vscode.window.activeTextEditor.document, {
                    preview: false,
                    viewColumn: vscode.window.activeTextEditor.viewColumn,
                });
            }
            // sorted
            /* let itemsSorted = [] =*/
            const b: File = book ? book : activeController.activeFile;
            sortBookmarks(b.bookmarks);
            saveWorkspaceState();
            updateDecorations();
        });
    }

    async function toggle(params?: EditorLineNumberContextParams) {
        const selections: Selection[] = [];

        if (params) {
            const posAnchor = new Position(params.lineNumber - 1, 0);
            const posActive = new Position(params.lineNumber - 1, 0);
            const sel = new Selection(posAnchor, posActive);
            selections.push(sel);
        } else {
            if (!vscode.window.activeTextEditor) {
                vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to toggle bookmarks"));
                return;
            }

            if (vscode.window.activeTextEditor.document.uri.scheme === SEARCH_EDITOR_SCHEME) {
                vscode.window.showInformationMessage(vscode.l10n.t("You can't toggle bookmarks in Search Editor"));
                return;
            }

            selections.push(...vscode.window.activeTextEditor.selections);
        }

        // fix issue emptyAtLaunch
        if (!activeController?.activeFile) {
            if (!ensureActiveFile(vscode.window.activeTextEditor.document)) {
                return;
            }
        }

        if (await activeController.toggle(selections)) {
            if (!isInDiffEditor()) {
                vscode.window.showTextDocument(vscode.window.activeTextEditor.document, {
                    preview: false,
                    viewColumn: vscode.window.activeTextEditor.viewColumn,
                });
            }
        }

        sortBookmarks(activeController.activeFile.bookmarks);
        saveWorkspaceState();
        updateDecorations();
        updateLinesWithBookmarkContext(activeController.activeFile);
        // bookmarkExplorer.updateBadge();
    }

    async function toggleLabeled(params?: EditorLineNumberContextParams) {
        const selections: Selection[] = [];

        if (params) {
            const posAnchor = new Position(params.lineNumber - 1, 0);
            const posActive = new Position(params.lineNumber - 1, 0);
            const sel = new Selection(posAnchor, posActive);
            selections.push(sel);
        } else {
            if (!vscode.window.activeTextEditor) {
                vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to toggle bookmarks"));
                return;
            }

            selections.push(...vscode.window.activeTextEditor.selections);
        }
        // fix issue emptyAtLaunch
        if (!activeController?.activeFile) {
            if (!ensureActiveFile(vscode.window.activeTextEditor.document)) {
                return;
            }
        }

        let suggestion = suggestLabel(vscode.window.activeTextEditor.selection);
        if (!params && suggestion !== "" && useSelectionWhenAvailable()) {
            if (await activeController.toggle(selections, suggestion)) {
                vscode.window.showTextDocument(vscode.window.activeTextEditor.document, {
                    preview: false,
                    viewColumn: vscode.window.activeTextEditor.viewColumn,
                });
            }
            sortBookmarks(activeController.activeFile.bookmarks);
            saveWorkspaceState();
            updateDecorations();
            updateLinesWithBookmarkContext(activeController.activeFile);
            return;
        }

        // ask label
        let oldLabel = "";
        if (!params && suggestion === "" && selections.length === 1) {
            const index = indexOfBookmark(activeController.activeFile, selections[0].active.line);
            oldLabel = index > -1 ? activeController.activeFile.bookmarks[index].label : "";
            suggestion = oldLabel;
        }
        // let oldLabel: string = "";
        // if (selections.length === 1) {
        //     const index = bookmarks.activeBookmark.indexOfBookmark(selections[0].active.line);
        //     oldLabel = index > -1 ? bookmarks.activeBookmark.bookmarks[index].label : "";
        // }
        const ibo = <vscode.InputBoxOptions>{
            prompt: vscode.l10n.t("Bookmark Label"),
            placeHolder: vscode.l10n.t("Type a label for your bookmark"),
            value: !params ? suggestion : "",
        };
        const newLabel = await vscode.window.showInputBox(ibo);
        if (typeof newLabel === "undefined") {
            return;
        }
        if (newLabel === "" && oldLabel === "") {
            vscode.window.showWarningMessage(vscode.l10n.t("You must define a label for the bookmark."));
            return;
        }

        if (await activeController.toggle(selections, newLabel)) {
            vscode.window.showTextDocument(vscode.window.activeTextEditor.document, {
                preview: false,
                viewColumn: vscode.window.activeTextEditor.viewColumn,
            });
        }

        // sorted
        /* let itemsSorted = [] =*/
        const b: File = activeController.activeFile;
        b.bookmarks.sort((n1, n2) => {
            if (n1.line > n2.line) {
                return 1;
            }
            if (n1.line < n2.line) {
                return -1;
            }
            return 0;
        });

        saveWorkspaceState();
        updateDecorations();
        updateLinesWithBookmarkContext(activeController.activeFile);
    }
}
