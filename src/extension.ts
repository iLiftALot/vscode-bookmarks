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
import { BookmarkQuickPickItem } from "./core/bookmark";
import {
    Directions,
    NO_BOOKMARKS_AFTER,
    NO_BOOKMARKS_BEFORE,
    NO_MORE_BOOKMARKS,
    SEARCH_EDITOR_SCHEME,
    isWindows
} from "./core/constants";
import { Container } from "./core/container";
import { Controller } from "./core/controller";
import { File } from "./core/file";
import { indexOfBookmark, listBookmarks, nextBookmark, sortBookmarks } from "./core/operations";
import {
    createBookmarkDecorations,
    createBookmarkLabelInlineDecoration,
    updateDecorationsInActiveEditor
} from "./decoration/decoration";
import { registerGutterCommands } from "./gutter/commands";
import { EditorLineNumberContextParams, updateLinesWithBookmarkContext } from "./gutter/editorLineNumberContext";
import { pickController } from "./quickpick/controllerPicker";
import { expandSelectionToNextBookmark, selectBookmarkedLines, shrinkSelection } from "./selections";
import { BookmarksExplorer } from "./sidebar/bookmarkProvider";
import { registerHelpAndFeedbackView } from "./sidebar/helpAndFeedbackView";
import { ViewAs } from "./sidebar/nodes";
import { parsePosition } from "./sidebar/parser";
import { updateStickyBookmarks } from "./sticky/sticky";
import { Sticky } from "./sticky/stickyLegacy";
import { loadBookmarks, saveBookmarks } from "./storage/workspaceState";
import { suggestLabel, useSelectionWhenAvailable } from "./suggestion";
import { appendPath, getRelativePath } from "./utils/fs";
import { previewPositionInDocument, revealPosition } from "./utils/reveal";
import { registerWhatsNew } from "./whats-new/commands";

// this method is called when vs code is activated
export async function activate(context: vscode.ExtensionContext) {
    Container.context = context;

    let controllers: Controller[] = [];
    let activeEditorCountLine: number;
    let timeout: NodeJS.Timeout | null = null;

    let saveBookmarksInProjectSetting = vscode.workspace.getConfiguration("bookmarks").get<boolean>(
        "saveBookmarksInProject",
        false
    );

    await registerWhatsNew();
    await registerWalkthrough();

    context.subscriptions.push(vscode.commands.registerCommand("_bookmarks.openFolderWelcome", () => {
        const openFolderCommand = isWindows
            ? "workbench.action.files.openFolder"
            : "workbench.action.files.openFileFolder";
        vscode.commands.executeCommand(openFolderCommand);
    }));

    // load pre-saved bookmarks
    let activeController = await loadWorkspaceState();

    registerOpenSettings();
    registerSupportBookmarks();
    registerExport(() => controllers);
    registerHelpAndFeedbackView(context);

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (cfg) => {
        // Allow change the gutterIcon and inline label decoration without reload
        if (
            cfg.affectsConfiguration("bookmarks.gutterIconFillColor")
            || cfg.affectsConfiguration("bookmarks.gutterIconBorderColor")
            || cfg.affectsConfiguration("bookmarks.overviewRulerLane")
            || cfg.affectsConfiguration("bookmarks.label.inline.enabled")
            || cfg.affectsConfiguration("bookmarks.label.inline.margin")
            || cfg.affectsConfiguration("bookmarks.label.inline.fontStyle")
            || cfg.affectsConfiguration("bookmarks.label.inline.fontWeight")
        ) {
            if (bookmarkDecorationType.length > 0) {
                bookmarkDecorationType.forEach((b) => b.dispose());
            }
            bookmarkLabelInlineDecoration.dispose();

            bookmarkDecorationType = createBookmarkDecorations();
            bookmarkLabelInlineDecoration = createBookmarkLabelInlineDecoration();
            context.subscriptions.push(...bookmarkDecorationType);
            context.subscriptions.push(bookmarkLabelInlineDecoration);

            updateDecorations();
            bookmarkProvider.refresh();
        }

        if (cfg.affectsConfiguration("bookmarks.saveBookmarksInProject")) {
            const newSaveBookmarksInProjectSetting = vscode.workspace.getConfiguration("bookmarks").get<boolean>(
                "saveBookmarksInProject",
                false
            );

            const changedFromFalseToTrue = !saveBookmarksInProjectSetting && newSaveBookmarksInProjectSetting;
            saveBookmarksInProjectSetting = newSaveBookmarksInProjectSetting;

            if (
                changedFromFalseToTrue && vscode.workspace.workspaceFolders && vscode
                        .workspace
                        .workspaceFolders
                        .length > 0
            ) {
                let hasAnyBookmarksFile = false;
                let mostRecentMtime: number | undefined;
                const isSingleWorkspace = vscode.workspace.workspaceFolders.length === 1;

                // Check all workspace folders to find if bookmarks.json exists
                // For multi-root, track the most recent modification time
                for (const workspaceFolder of vscode.workspace.workspaceFolders) {
                    const bookmarksFileInProject = appendPath(
                        appendPath(workspaceFolder.uri, ".vscode"),
                        "bookmarks.json"
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
                            console.error("Error while checking for project bookmarks file:", error);
                        }
                    }
                }

                if (hasAnyBookmarksFile && mostRecentMtime !== undefined) {
                    const loadOption = vscode.l10n.t("Load bookmarks from project");
                    const message = vscode.l10n.t(
                        "A local copy of bookmarks was found in the project. Do you want to load?"
                    );
                    const mostRecentModificationLabel = new Date(mostRecentMtime).toLocaleString();

                    // Different messages for single vs multi-root workspaces
                    const detailMessage = isSingleWorkspace
                        ? vscode.l10n.t("The project's file was last modified at {0}", mostRecentModificationLabel)
                        : vscode.l10n.t(
                            "One of the projects in the workspace has a bookmarks file. The most recent was modified at {0}",
                            mostRecentModificationLabel
                        );

                    const selection = await vscode.window.showInformationMessage(
                        message,
                        { modal: true, detail: detailMessage },
                        loadOption
                    );

                    if (selection === loadOption) {
                        const oldControllers = controllers.slice();
                        activeController = await loadWorkspaceState();
                        for (const controller of oldControllers) {
                            const disposable = controller as unknown as { dispose?: () => void };
                            if (typeof disposable.dispose === "function") {
                                disposable.dispose();
                            }
                        }
                        bookmarkExplorer.updateControllers(controllers);
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            getEditorContext(editor);
                        }
                        updateDecorations();
                        updateLinesWithBookmarkContext(activeController.activeFile);
                        return;
                    }

                    // cancelled: fall through to default handling below without changing controllers
                }
            }

            splitOrMergeFilesInMultiRootControllers();
            await saveWorkspaceState();
        }

        if (cfg.affectsConfiguration("bookmarks.sideBar.countBadge")) {
            bookmarkExplorer.updateBadge();
        }

        if (cfg.affectsConfiguration("bookmarks.sideBar.hideWelcome")) {
            toggleSideBarWelcomeVisibility();
        }
    }));

    let bookmarkDecorationType = createBookmarkDecorations();
    let bookmarkLabelInlineDecoration = createBookmarkLabelInlineDecoration();
    context.subscriptions.push(...bookmarkDecorationType);
    context.subscriptions.push(bookmarkLabelInlineDecoration);

    // Connect it to the Editors Events
    let activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        getEditorContext(activeEditor);
        activeEditorCountLine = activeEditor.document.lineCount;
        triggerUpdateDecorations();
        updateLinesWithBookmarkContext(activeController.activeFile);
    }

    const bookmarkExplorer = new BookmarksExplorer(controllers);
    const bookmarkProvider = bookmarkExplorer.getProvider();

    bookmarkExplorer.updateBadge();
    toggleSideBarWelcomeVisibility();

    vscode.commands.registerCommand("_bookmarks.sidebar.hidePosition", () => toggleSidebarPositionVisibility(false));
    vscode.commands.registerCommand("_bookmarks.sidebar.showPosition", () => toggleSidebarPositionVisibility(true));
    vscode.commands.executeCommand(
        "setContext",
        "bookmarks.isHidingPosition",
        Container.context.globalState.get<boolean>("bookmarks.sidebar.hidePosition", false)
    );

    function toggleSideBarWelcomeVisibility() {
        vscode.commands.executeCommand(
            "setContext",
            "bookmarks.isHidingWelcome",
            vscode.workspace.getConfiguration("bookmarks").get("sideBar.hideWelcome", false)
        );
    }

    function toggleSidebarPositionVisibility(visible: boolean) {
        vscode.commands.executeCommand("setContext", "bookmarks.isHidingPosition", !visible);
        Container.context.globalState.update("bookmarks.sidebar.hidePosition", !visible);
        bookmarkProvider.refresh();
    }

    const viewAsList = Container.context.globalState.get<boolean>("viewAsList", false);

    vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", viewAsList);
    vscode.commands.registerCommand("_bookmarks.viewAsTree#sideBar", () => toggleViewAs(ViewAs.VIEW_AS_TREE));
    vscode.commands.registerCommand("_bookmarks.viewAsList#sideBar", () => toggleViewAs(ViewAs.VIEW_AS_LIST));

    function toggleViewAs(view: ViewAs) {
        if (view === ViewAs.VIEW_AS_LIST) {
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", true);
        } else {
            vscode.commands.executeCommand("setContext", "bookmarks.viewAsList", false);
        }
        Container.context.globalState.update("viewAsList", view === ViewAs.VIEW_AS_LIST);
        bookmarkProvider.refresh();
    }

    vscode.window.onDidChangeActiveTextEditor(
        (editor) => {
            activeEditor = editor;

            if (editor) {
                activeEditorCountLine = editor.document.lineCount;
                getEditorContext(editor);
                triggerUpdateDecorations();
            } else {
                activeController.activeFile = undefined;
            }

            updateLinesWithBookmarkContext(activeController.activeFile);
        },
        null,
        context.subscriptions
    );

    vscode.workspace.onDidChangeTextDocument(
        async (event) => {
            if (activeEditor && event.document === activeEditor.document) {
                //            triggerUpdateDecorations();
                let updatedBookmark = false;

                // workaround for formatters like Prettier (#118)
                if (vscode.workspace.getConfiguration("bookmarks").get("useWorkaroundForFormatters", false)) {
                    updateDecorations();
                    return;
                }

                // call sticky function when the activeEditor is changed
                if (activeController.activeFile && activeController.activeFile.bookmarks.length > 0) {
                    if (
                        vscode.workspace.getConfiguration("bookmarks").get<boolean>(
                            "experimental.enableNewStickyEngine",
                            true
                        )
                    ) {
                        updatedBookmark = updateStickyBookmarks(
                            event,
                            activeController.activeFile,
                            activeEditor,
                            activeController
                        );
                    } else {
                        updatedBookmark = Sticky.stickyBookmarks(
                            event,
                            activeEditorCountLine,
                            activeController.activeFile,
                            activeEditor,
                            activeController
                        );
                    }
                }

                activeEditorCountLine = event.document.lineCount;
                updateDecorations();

                if (updatedBookmark) {
                    await saveWorkspaceState();
                }
            }
        },
        null,
        context.subscriptions
    );

    context.subscriptions.push(vscode.workspace.onDidRenameFiles(async (rename) => {
        if (rename.files.length === 0) return;

        for (const file of rename.files) {
            const controller = getControllerForUri(file.oldUri);
            const files = controller.files.map((f) => f.path);
            const stat = await vscode.workspace.fs.stat(file.newUri);

            const fileRelativeOldPath = getRelativePath(controller.workspaceFolder?.uri.path, file.oldUri.path);
            const fileRelativeNewPath = getRelativePath(controller.workspaceFolder?.uri.path, file.newUri.path);

            if (stat.type === vscode.FileType.File) {
                if (files.includes(fileRelativeOldPath)) {
                    controller.updateFilePath(fileRelativeOldPath, fileRelativeNewPath);
                }
            }
            if (stat.type === vscode.FileType.Directory) {
                controller.updateDirectoryPath(fileRelativeOldPath, fileRelativeNewPath);
            }
        }

        bookmarkProvider.refresh();
        await saveWorkspaceState();
        if (activeEditor) {
            activeController.activeFile = activeController.fromUri(activeEditor.document.uri);
            updateDecorations();
        }
    }));

    // Timeout
    function triggerUpdateDecorations() {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(updateDecorations, 100);
    }

    // Evaluate (prepare the list) and DRAW
    function updateDecorations() {
        updateDecorationsInActiveEditor(
            activeEditor,
            activeController,
            bookmarkDecorationType,
            bookmarkLabelInlineDecoration
        );
    }

    updateDecorations();

    vscode.commands.registerCommand("_bookmarks.jumpTo", (documentPath, line, column: string, uri: Uri) => {
        vscode.workspace.openTextDocument(uri).then((doc) => {
            vscode.window.showTextDocument(doc).then(() => {
                const lineInt: number = parseInt(line, 10);
                const colunnInt: number = parseInt(column, 10);
                revealPosition(lineInt - 1, colunnInt - 1);
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
        const editor = vscode.window.activeTextEditor;

        // Validate if there is an open file in the editor
        if (!editor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to add bookmarks"));
            return;
        }

        if (editor.document.uri.scheme === SEARCH_EDITOR_SCHEME) {
            vscode.window.showInformationMessage(vscode.l10n.t("You can't add bookmarks in Search Editor"));
            return;
        }

        const { file, controller } = getEditorContext(editor);
        const currentPosition = editor.selection.active;
        const index = indexOfBookmark(file, currentPosition.line);

        // Scenario 1: No bookmark at current line -> add new bookmark
        if (index === -1) {
            await toggle();
            return;
        }

        const bookmark = file.bookmarks[index];

        // Scenario 2: Regular bookmark found -> show information message
        if (!bookmark.label || bookmark.label === "") {
            vscode.window.showInformationMessage(vscode.l10n.t("There is already a bookmark at this line"));
            return;
        }

        // Scenario 3: Labeled bookmark found -> edit the label
        const position: vscode.Position = new vscode.Position(currentPosition.line, currentPosition.character);
        const suggestedLabel = bookmark.label;
        await askForBookmarkLabel(index, position, suggestedLabel, false, file, controller);
    });

    vscode.commands.registerCommand("_bookmarks.clearFromFile", async (node) => {
        const controller = controllers.find((candidate) => candidate.files.includes(node.bookmark));
        if (!controller) {
            return;
        }

        // Check if we should confirm before clearing (this is from Side Bar)
        const shouldProceed = await shouldConfirmClear("sideBar");
        if (!shouldProceed) {
            return;
        }

        controller.clear(node.bookmark);
        await saveWorkspaceState();
        updateDecorations();
    });

    vscode.commands.registerCommand("_bookmarks.deleteBookmark", async (node) => {
        const controller = getControllerForUri(node.command.arguments[3]);
        const book = controller.fromUri(node.command.arguments[3]);
        if (!book) {
            return;
        }

        const index = indexOfBookmark(book, node.command.arguments[1] - 1);
        if (index === -1) {
            return;
        }

        controller.removeBookmark(index, node.command.arguments[1] - 1, book);
        await saveWorkspaceState();
        updateDecorations();
    });

    vscode.commands.registerCommand("_bookmarks.editLabel", async (node) => {
        const controller = getControllerForUri(node.command.arguments[3]);
        const book = controller.fromUri(node.command.arguments[3]);
        if (!book) {
            return;
        }

        const index = indexOfBookmark(book, node.command.arguments[1] - 1);
        if (index === -1) {
            return;
        }

        const position: vscode.Position = new vscode.Position(
            node.command.arguments[1] - 1,
            node.command.arguments[2] - 1
        );
        const suggestedLabel = book.bookmarks[index].label || node.label;
        await askForBookmarkLabel(index, position, suggestedLabel, false, book, controller);
    });

    vscode.commands.registerCommand("bookmarks.clear", () => clear("commandPalette"));
    vscode.commands.registerCommand("bookmarks.clearFromAllFiles", () => clearFromAllFiles());
    vscode.commands.registerCommand("_bookmarks.clearFromAllFiles#sideBar", () => clearFromAllFiles());
    vscode.commands.registerCommand("bookmarks.selectLines", () => selectBookmarkedLines(activeController));
    vscode.commands.registerCommand(
        "bookmarks.expandSelectionToNext",
        () => expandSelectionToNextBookmark(activeController, Directions.Forward)
    );
    vscode.commands.registerCommand(
        "bookmarks.expandSelectionToPrevious",
        () => expandSelectionToNextBookmark(activeController, Directions.Backward)
    );
    vscode.commands.registerCommand("bookmarks.shrinkSelection", () => shrinkSelection(activeController));
    vscode.commands.registerCommand("bookmarks.toggle", () => toggle());
    vscode.commands.registerCommand("bookmarks.toggleLabeled", () => toggleLabeled());
    vscode.commands.registerCommand("bookmarks.jumpToNext", () => jumpToNext(Directions.Forward));
    vscode.commands.registerCommand("bookmarks.jumpToPrevious", () => jumpToNext(Directions.Backward));
    vscode.commands.registerCommand("bookmarks.list", () => list());
    vscode.commands.registerCommand("bookmarks.listFromAllFiles", () => listFromAllFiles());

    function getControllerForUri(uri: Uri): Controller {
        const folder = vscode.workspace.getWorkspaceFolder(uri);

        const controller = folder && controllers.length > 1
            ? controllers.find((candidate) => candidate.workspaceFolder?.uri.toString() === folder.uri.toString())
            : controllers[0];

        if (!controller) {
            throw new Error("No bookmark controller is available for this document.");
        }

        return controller;
    }

    function getActiveController(document: TextDocument): Controller {
        const controller = getControllerForUri(document.uri);
        activeController = controller;
        return controller;
    }

    function getEditorContext(editor: vscode.TextEditor): {
        editor: vscode.TextEditor;
        controller: Controller;
        file: File;
    } {
        const controller = getActiveController(editor.document);
        controller.addFile(editor.document.uri);

        const file = controller.fromUri(editor.document.uri);
        if (!file) {
            throw new Error("The editor's bookmark file could not be initialized.");
        }

        controller.activeFile = file;
        return { editor, controller, file };
    }

    function splitOrMergeFilesInMultiRootControllers(): void {
        //
        if ((vscode.workspace.workspaceFolders?.length ?? 0) < 2) {
            return;
        }

        // ?? needs work
        const saveBookmarksInProject = vscode.workspace.getConfiguration("bookmarks").get(
            "saveBookmarksInProject",
            false
        );

        if (saveBookmarksInProject) {
            const validFiles = activeController.files.filter((file) => !file.path.startsWith(".."));
            activeController.files = [ ...validFiles ];
        }
    }

    async function loadWorkspaceState(): Promise<Controller> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const saveInProject = vscode.workspace.getConfiguration("bookmarks").get<boolean>(
            "saveBookmarksInProject",
            false
        );

        const loadedControllers = saveInProject && folders.length > 0
            ? await Promise.all(folders.map((folder) => loadBookmarks(folder)))
            : [ await loadBookmarks(folders[0]) ];

        const firstController = loadedControllers[0];
        if (!firstController) {
            throw new Error("Bookmark controllers could not be initialized.");
        }

        controllers = loadedControllers;
        return firstController;
    }

    async function saveWorkspaceState(): Promise<void> {
        await Promise.all(controllers.map((controller) => saveBookmarks(controller)));
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
                    label: lineText
                });
            } else {
                items.push({
                    description: "(Ln " + bookmarkLine.toString() + ", Col " + bookmarkColumn.toString() + ")",
                    label: codicons.tag + " " + activeController.activeFile.bookmarks[index].label
                });
            }
        }

        // pick one
        const currentPosition: Position = vscode.window.activeTextEditor.selection.active;
        const options = <vscode.QuickPickOptions> {
            placeHolder: vscode.l10n.t("Type a line number or a piece of code to navigate to"),
            matchOnDescription: true,
            // matchOnDetail: true,
            onDidSelectItem: (item) => {
                const itemT = <vscode.QuickPickItem> item;
                const point = parsePosition(itemT.description);
                if (point) {
                    revealPosition(point.line - 1, point.column - 1);
                }
            }
        };

        vscode.window.showQuickPick(items, options).then((selection) => {
            if (typeof selection === "undefined") {
                revealPosition(currentPosition.line, currentPosition.character);
                return;
            }
            const itemT = <vscode.QuickPickItem> selection;
            const point = parsePosition(itemT.description);
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

        const result = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            clearButton
        );

        return result === clearButton;
    }

    async function clear(source: "commandPalette" | "sideBar" = "commandPalette") {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to clear bookmarks"));
            return;
        }

        const { controller, file } = getEditorContext(editor);

        // Check if we should confirm before clearing
        const shouldProceed = await shouldConfirmClear(source);
        if (!shouldProceed || !controllers.includes(controller) || !controller.files.includes(file)) {
            return;
        }

        controller.clear(file);
        await saveWorkspaceState();
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

                const result = await vscode.window.showWarningMessage(
                    message,
                    { modal: true },
                    clearButton
                );

                if (result !== clearButton) {
                    return;
                }
            }
        }

        controller.clearAll();

        await saveWorkspaceState();
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
        const currentPosition = activeTextEditor?.selection.active;

        for (const bookmark of controller.files) {
            const pp = listBookmarks(bookmark, controller.workspaceFolder);
            promisses.push(pp);
        }

        Promise.all(promisses).then(
            (values) => {
                for (const element of values) {
                    if (element) {
                        for (const elementInside of element) {
                            if (
                                activeTextEditor
                                && elementInside.detail?.toLocaleLowerCase() === getRelativePath(
                                        controller.workspaceFolder?.uri.path,
                                        activeTextEditor.document.uri.path
                                    )
                                        .toLocaleLowerCase()
                            ) {
                                items.push(
                                    {
                                        label: elementInside.label,
                                        description: elementInside.description,
                                        uri: elementInside.uri
                                    }
                                );
                            } else {
                                items.push(
                                    {
                                        label: elementInside.label,
                                        description: elementInside.description,
                                        detail: elementInside.detail,
                                        uri: elementInside.uri
                                    }
                                );
                            }
                        }
                    }
                }

                // sort
                // - active document
                // - no octicon - document in same workspaceFolder
                // - with octicon 'file-submodules' - document in another workspaceFolder
                // - with octicon - 'file-directory' - document outside any workspaceFolder
                const itemsSorted: vscode.QuickPickItem[] = items.sort(
                    function (a: vscode.QuickPickItem, b: vscode.QuickPickItem): number {
                        if (!a.detail && !b.detail) {
                            return 0;
                        }

                        if (!a.detail && b.detail) {
                            return -1;
                        }

                        if (a.detail && !b.detail) {
                            return 1;
                        }

                        if (!a.detail || !b.detail) {
                            return 0;
                        }

                        if (
                            (a
                                .detail
                                .toString()
                                .indexOf(codicons.file_submodule + " ") === 0)
                            && (b.detail.toString().indexOf(codicons.file_directory + " ") === 0)
                        ) {
                            return -1;
                        }

                        if (
                            (a.detail.toString().indexOf(codicons.file_directory + " ") === 0)
                            && (b.detail.toString().indexOf(codicons.file_submodule + " ") === 0)
                        ) {
                            return 1;
                        }

                        if (
                            (a.detail.toString().indexOf(codicons.file_submodule + " ") === 0)
                            && (b.detail.toString().indexOf(codicons.file_submodule + " ") === -1)
                        ) {
                            return 1;
                        }

                        if (
                            (a.detail.toString().indexOf(codicons.file_submodule + " ") === -1)
                            && (b.detail.toString().indexOf(codicons.file_submodule + " ") === 0)
                        ) {
                            return -1;
                        }

                        if (
                            (a.detail.toString().indexOf(codicons.file_directory + " ") === 0)
                            && (b.detail.toString().indexOf(codicons.file_directory + " ") === -1)
                        ) {
                            return 1;
                        }

                        if (
                            (a.detail.toString().indexOf(codicons.file_directory + " ") === -1)
                            && (b.detail.toString().indexOf(codicons.file_directory + " ") === 0)
                        ) {
                            return -1;
                        }

                        return 0;
                    }
                );

                const options = <vscode.QuickPickOptions> {
                    placeHolder: vscode.l10n.t("Type a line number or a piece of code to navigate to"),
                    matchOnDescription: true,
                    onDidSelectItem: (item) => {
                        const itemT = <BookmarkQuickPickItem> item;
                        const fileUri = itemT.uri;
                        const point = parsePosition(itemT.description);
                        if (!point) {
                            return;
                        }

                        if (
                            vscode.window.activeTextEditor
                            && vscode.window.activeTextEditor.document.uri.fsPath.toLowerCase() === fileUri
                                    .fsPath
                                    .toLowerCase()
                        ) {
                            revealPosition(point.line - 1, point.column - 1);
                        } else {
                            previewPositionInDocument(point, fileUri);
                        }
                    }
                };
                vscode.window.showQuickPick(itemsSorted, options).then((selection) => {
                    if (typeof selection === "undefined") {
                        if (!activeTextEditor || !currentPosition) {
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

                    const point = parsePosition(selection.description);
                    if (!selection.detail && point) {
                        revealPosition(point.line - 1, point.column - 1);
                    }
                });
            }
        );
    }

    function jumpToNext(direction: Directions) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to jump to bookmarks"));
            return;
        }

        const controller = getActiveController(editor.document);
        const file = controller.fromUri(editor.document.uri);
        if (!file) {
            return;
        }

        //
        nextBookmark(file, editor.selection.active, direction)
            .then((next) => {
                if (typeof next === "number") {
                    if (!checkBookmarks(next)) {
                        return;
                    }

                    controller
                        .nextDocumentWithBookmarks(file, direction)
                        .then((nextDocument) => {
                            if (typeof nextDocument === "number") {
                                if (nextDocument !== NO_MORE_BOOKMARKS) {
                                    checkBookmarks(nextDocument);
                                }
                                return;
                            }

                            let uriDocument: Uri;
                            if (typeof nextDocument === "string") {
                                uriDocument = !controller.workspaceFolder
                                    ? Uri.file(nextDocument.toString())
                                    : appendPath(controller.workspaceFolder.uri, nextDocument.toString());
                            } else {
                                uriDocument = <Uri> nextDocument;
                            }

                            // same document?
                            //   const activeDocument = getRelativePath(activeController.workspaceFolder?.uri?.path, vscode.window.activeTextEditor.document.uri.fsPath);
                            //   if (nextDocument.toString() === activeDocument) {
                            if (uriDocument.fsPath === editor.document.uri.fsPath) {
                                const bookmarkIndex = direction === Directions.Forward
                                    ? 0
                                    : file.bookmarks.length - 1;
                                const bookmark = file.bookmarks[bookmarkIndex];
                                if (bookmark) {
                                    revealPosition(bookmark.line, bookmark.column);
                                }
                            } else {
                                // const uriDocument = !activeController.workspaceFolder
                                //     ? Uri.file(nextDocument.toString())
                                //     : appendPath(activeController.workspaceFolder.uri, nextDocument.toString());
                                const tabGroupColumn = findTabGroupColumn(
                                    uriDocument,
                                    editor.viewColumn ?? ViewColumn.Active
                                );

                                vscode.workspace.openTextDocument(uriDocument).then((doc) => {
                                    vscode.window.showTextDocument(doc, tabGroupColumn).then(() => {
                                        const destinationFile = controller.fromUri(doc.uri);
                                        if (!destinationFile || destinationFile.bookmarks.length === 0) {
                                            return;
                                        }

                                        const bookmarkIndex = direction === Directions.Forward
                                            ? 0
                                            : destinationFile.bookmarks.length - 1;

                                        const bookmark = destinationFile.bookmarks[bookmarkIndex];
                                        if (!bookmark) {
                                            return;
                                        }

                                        revealPosition(bookmark.line, bookmark.column);
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
                console.log("activeBookmark.nextBookmark REJECT" + error);
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
            if (tabGroup.viewColumn === column) {
                continue;
            }

            for (const tab of tabGroup.tabs) {
                if (isTabOfUri(tab, uri)) {
                    return tab.group.viewColumn;
                }
            }
        }

        return column;
    }

    function isTabOfUri(tab: Tab, uri: Uri): boolean {
        return tab.input instanceof TabInputText
            && tab.input.uri.fsPath.toLocaleLowerCase() === uri.fsPath.toLocaleLowerCase();
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

    async function askForBookmarkLabel(
        index: number,
        position: vscode.Position,
        oldLabel?: string,
        jumpToPosition?: boolean,
        book?: File,
        controller: Controller = activeController
    ): Promise<void> {
        const file = book ?? controller.activeFile;
        if (!file) {
            return;
        }

        const editor = vscode.window.activeTextEditor;
        const bookmarkLabel = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("Bookmark Label"),
            placeHolder: vscode.l10n.t("Type a label for your bookmark"),
            value: oldLabel
        });

        if (bookmarkLabel === undefined || !controllers.includes(controller) || !controller.files.includes(file)) {
            return;
        }

        if (bookmarkLabel === "" && oldLabel === "") {
            vscode.window.showWarningMessage(vscode.l10n.t("You must define a label for the bookmark."));
            return;
        }

        if (index >= 0) {
            const currentIndex = indexOfBookmark(file, position.line);
            if (currentIndex === -1) {
                return;
            }
            controller.removeBookmark(currentIndex, position.line, file);
        }

        await controller.addBookmark(position, bookmarkLabel, file);

        if (jumpToPosition && editor && controller.fromUri(editor.document.uri) === file) {
            await vscode.window.showTextDocument(editor.document, {
                preview: false,
                viewColumn: editor.viewColumn
            });
        }

        sortBookmarks(file);
        await saveWorkspaceState();
        updateDecorations();
        updateLinesWithBookmarkContext(activeController.activeFile);
    }

    async function toggle(params?: EditorLineNumberContextParams) {
        const editor = params
            ? vscode.window.visibleTextEditors.find((candidate) =>
                candidate.document.uri.toString() === params.uri.toString()
            )
            : vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to toggle bookmarks"));
            return;
        }

        if (editor.document.uri.scheme === SEARCH_EDITOR_SCHEME) {
            vscode.window.showInformationMessage(vscode.l10n.t("You can't toggle bookmarks in Search Editor"));
            return;
        }

        const { controller, file } = getEditorContext(editor);
        const selections: Selection[] = params
            ? [ new Selection(params.lineNumber - 1, 0, params.lineNumber - 1, 0) ]
            : [ ...editor.selections ];

        if (await controller.toggle(selections, undefined, file)) {
            if (editor.viewColumn !== undefined) {
                await vscode.window.showTextDocument(editor.document, {
                    preview: false,
                    viewColumn: editor.viewColumn
                });
            }
        }

        sortBookmarks(file);
        await saveWorkspaceState();
        updateDecorations();
        updateLinesWithBookmarkContext(activeController.activeFile);
        // bookmarkExplorer.updateBadge();
    }

    async function toggleLabeled(params?: EditorLineNumberContextParams) {
        const editor = params
            ? vscode.window.visibleTextEditors.find((candidate) =>
                candidate.document.uri.toString() === params.uri.toString()
            )
            : vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showInformationMessage(vscode.l10n.t("Open a file first to toggle bookmarks"));
            return;
        }

        if (editor.document.uri.scheme === SEARCH_EDITOR_SCHEME) {
            vscode.window.showInformationMessage(vscode.l10n.t("You can't toggle bookmarks in Search Editor"));
            return;
        }

        const { controller, file } = getEditorContext(editor);

        const selections: Selection[] = params
            ? [ new Selection(params.lineNumber - 1, 0, params.lineNumber - 1, 0) ]
            : [ ...editor.selections ];

        let suggestion = suggestLabel(editor.selection);
        if (!params && suggestion !== "" && useSelectionWhenAvailable()) {
            if (await controller.toggle(selections, suggestion, file)) {
                vscode.window.showTextDocument(editor.document, {
                    preview: false,
                    viewColumn: editor.viewColumn
                });
            }
            sortBookmarks(file);
            await saveWorkspaceState();
            updateDecorations();
            updateLinesWithBookmarkContext(activeController.activeFile);
            return;
        }

        // ask label
        let oldLabel = "";
        if (!params && suggestion === "" && selections.length === 1) {
            const index = indexOfBookmark(file, selections[0].active.line);
            oldLabel = index > -1 ? file.bookmarks[index]?.label ?? "" : "";
            suggestion = oldLabel;
        }
        // let oldLabel: string = "";
        // if (selections.length === 1) {
        //     const index = bookmarks.activeBookmark.indexOfBookmark(selections[0].active.line);
        //     oldLabel = index > -1 ? bookmarks.activeBookmark.bookmarks[index].label : "";
        // }
        const ibo = <vscode.InputBoxOptions> {
            prompt: vscode.l10n.t("Bookmark Label"),
            placeHolder: vscode.l10n.t("Type a label for your bookmark"),
            value: !params ? suggestion : ""
        };
        const newLabel = await vscode.window.showInputBox(ibo);
        if (newLabel === undefined || !controllers.includes(controller) || !controller.files.includes(file)) return;
        if (newLabel === "" && oldLabel === "") {
            vscode.window.showWarningMessage(vscode.l10n.t("You must define a label for the bookmark."));
            return;
        }

        if (await controller.toggle(selections, newLabel, file)) {
            vscode.window.showTextDocument(editor.document, {
                preview: false,
                viewColumn: editor.viewColumn
            });
        }

        // sorted
        /* let itemsSorted = [] =*/
        const b: File = file;
        b.bookmarks.sort((n1, n2) => {
            if (n1.line > n2.line) {
                return 1;
            }
            if (n1.line < n2.line) {
                return -1;
            }
            return 0;
        });

        await saveWorkspaceState();
        updateDecorations();
        updateLinesWithBookmarkContext(activeController.activeFile);
    }
}
