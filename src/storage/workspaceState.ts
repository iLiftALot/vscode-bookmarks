/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { WorkspaceFolder, l10n, window, workspace } from "vscode";
import { Container } from "../core/container";
import { Controller } from "../core/controller";
import { appendPath, createDirectoryUri, deleteFileUri, readFileUri, uriExists, writeFileUri } from "../utils/fs";

function canSaveBookmarksInProject(): boolean {
    let saveBookmarksInProject: boolean = workspace.getConfiguration("bookmarks").get("saveBookmarksInProject", false);

    // really use saveBookmarksInProject
    // 0. has at least a folder opened
    // 1. is a valid workspace/folder
    // 2. has only one workspaceFolder
    // let hasBookmarksFile: boolean = false;
    if (saveBookmarksInProject && !workspace.workspaceFolders) {
        saveBookmarksInProject = false;
    }

    return saveBookmarksInProject;
}

export async function loadBookmarks(workspaceFolder: WorkspaceFolder | undefined): Promise<Controller> {
    const saveBookmarksInProject: boolean = canSaveBookmarksInProject();

    const newController = new Controller(workspaceFolder);

    if (saveBookmarksInProject && workspaceFolder) {
        const bookmarksFileInProject = appendPath(appendPath(workspaceFolder.uri, ".vscode"), "bookmarks.json");
        if (!await uriExists(bookmarksFileInProject)) {
            return newController;
        }
        try {
            const contents = await readFileUri(bookmarksFileInProject);
            newController.loadFrom(contents, true);
            return newController;
        } catch (error) {
            window.showErrorMessage(l10n.t("Error loading Bookmarks: ") + String(error));
            return newController;
        }
    } else {
        const savedBookmarks = Container.context.workspaceState.get("bookmarks", "");
        if (savedBookmarks !== "") {
            newController.loadFrom(JSON.parse(savedBookmarks));
        }
        return newController;
    }
}

export async function saveBookmarks(controller: Controller): Promise<void> {
    const folder = controller.workspaceFolder;
    const snapshot = controller.zip();

    if (!canSaveBookmarksInProject() || !folder) {
        await Container.context.workspaceState.update("bookmarks", JSON.stringify(snapshot));
        return;
    }

    const directory = appendPath(folder.uri, ".vscode");
    const bookmarksFile = appendPath(directory, "bookmarks.json");

    if (snapshot.files.length === 0) {
        if (await uriExists(bookmarksFile)) {
            await deleteFileUri(bookmarksFile);
        }
        return;
    }

    if (!await uriExists(directory)) {
        await createDirectoryUri(directory);
    }

    await writeFileUri(bookmarksFile, JSON.stringify(snapshot, null, "\t"));
}
