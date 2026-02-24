/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { l10n, window, workspace, WorkspaceFolder } from "vscode";
import { Container } from "../core/container";
import { Controller } from "../core/controller";
import {
    appendPath,
    createDirectoryUri,
    deleteFileUri,
    fileSystemData,
    readFileUri,
    uriExists,
    writeFileUri,
} from "../utils/fs";
import { logger } from "../utils/logger";

function canSaveBookmarksInProject(): boolean {
    let saveBookmarksInProject: boolean = workspace.getConfiguration("bookmarks").get("saveBookmarksInProject", false);
    // logger.debug("workspaceState.canSaveBookmarksInProject", "Checking if saving bookmarks in project is possible...", {
    //     allowSaveBookmarksInProject: saveBookmarksInProject,
    //     hasWorkspaceFolders: !(workspace.workspaceFolders?.length ?? 0),
    // });

    // really use saveBookmarksInProject
    // 0. has at least a folder opened
    // 1. is a valid workspace/folder
    // 2. has only one workspaceFolder
    // let hasBookmarksFile: boolean = false;
    if (saveBookmarksInProject && !(workspace.workspaceFolders?.length ?? 0)) {
        saveBookmarksInProject = false;
    }

    return saveBookmarksInProject;
}

export async function loadBookmarks(workspaceFolder?: WorkspaceFolder): Promise<Controller> {
    const saveBookmarksInProject: boolean = canSaveBookmarksInProject();
    const newController = new Controller(workspaceFolder);

    logger.debug("workspaceState.loadBookmarks", "Loading bookmarks...", {
        allowSaveBookmarksInProject: saveBookmarksInProject,
        workspaceFolder: !workspaceFolder ? null : fileSystemData(workspaceFolder).dir,
    });

    if (saveBookmarksInProject) {
        // logger.debug("workspaceState.loadBookmarks", "Loading bookmarks from project file...", {
        //     testWs: Container.workspaceState.get("bookmarks", "[]"),
        //     testGs: {
        //         bm: Container.globalState.get("globalBookmarks", "[]"),
        //         bmHp: Container.globalState.get("bookmarks.sidebar.hidePosition", false),
        //         vaL: Container.globalState.get("viewAsList", false),
        //     },
        // });
        const bookmarksFileInProject = appendPath(appendPath(workspaceFolder.uri, ".vscode"), "bookmarks.json");
        if (!(await uriExists(bookmarksFileInProject))) {
            logger.warn(
                "workspaceState.loadBookmarks",
                "No bookmarks file found in project, starting with empty bookmarks",
                {
                    path: bookmarksFileInProject.fsPath,
                },
            );
            return newController;
        }
        try {
            const contents = await readFileUri(bookmarksFileInProject);
            newController.loadFrom(contents, true);
            logger.debug("workspaceState.loadBookmarks", "Loaded bookmarks from project file", {
                path: bookmarksFileInProject.fsPath,
                bookmarks: newController.countBookmarks(),
                loadedContents: contents,
            });
            return newController;
        } catch (error) {
            logger.error("workspaceState.loadBookmarks", "Error loading bookmarks from project file", error);
            window.showErrorMessage(l10n.t("Error loading Bookmarks: ") + error.toString());
            return newController;
        }
    } else {
        const savedBookmarks = Container.workspaceState.get("bookmarks", "");
        if (savedBookmarks !== "") {
            newController.loadFrom(JSON.parse(savedBookmarks));
            logger.debug("workspaceState.loadBookmarks", "Loaded bookmarks from workspace state", {
                path: newController.files,
                bookmarks: newController.countBookmarks(),
            });
        }
        return newController;
    }
}

export function saveBookmarks(controller: Controller): void {
    const saveBookmarksInProject: boolean = canSaveBookmarksInProject();

    if (saveBookmarksInProject) {
        const bookmarksFileInProject = appendPath(
            appendPath(controller.workspaceFolder.uri, ".vscode"),
            "bookmarks.json",
        );

        // avoid empty bookmarks.json file
        if (!controller.hasAnyBookmark()) {
            if (uriExists(bookmarksFileInProject)) {
                deleteFileUri(bookmarksFileInProject);
            }
            return;
        }

        if (!uriExists(appendPath(controller.workspaceFolder.uri, ".vscode"))) {
            createDirectoryUri(appendPath(controller.workspaceFolder.uri, ".vscode"));
        }
        writeFileUri(bookmarksFileInProject, JSON.stringify(controller.zip(), null, "\t"));
    } else {
        Container.workspaceState.update("bookmarks", JSON.stringify(controller.zip()));
    }
}
