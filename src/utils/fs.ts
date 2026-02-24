/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import os = require("os");
import path = require("path");
import { l10n, Uri, window, workspace, WorkspaceFolder } from "vscode";
import { Bookmark } from "../core/bookmark";
import { UNTITLED_SCHEME } from "../core/constants";
import { Container } from "../core/container";
import { File } from "../core/file";
import { logger } from "./logger";

interface FileSystemData extends path.ParsedPath {
    workspaceData: WorkspaceFolder | undefined;
    fileData: File;
}

export function getRelativePath(folder: string, filePath: string) {
    if (!folder) {
        return filePath;
    }

    let relativePath = path.relative(folder, filePath);

    // multiplatform
    if (os.platform() === "win32") {
        relativePath = relativePath.replace(/\\/g, "/");
    }

    return relativePath;
}

export function appendPath(uri: Uri, pathSuffix: string): Uri {
    const pathPrefix = uri.path.endsWith("/") ? uri.path : `${uri.path}/`;
    const filePath = `${pathPrefix}${pathSuffix}`;
    logger.debug("fs.appendPath", "Appending path to URI", {
        originalUri: uri.toString(),
        pathSuffix: pathSuffix,
        resultingPath: filePath,
    });
    return uri.with({
        path: filePath,
    });
}

export function uriJoin(uri: Uri, ...paths: string[]): string {
    return path.join(uri.fsPath, ...paths);
}

export function uriWith(uri: Uri, prefix: string, filePath: string): Uri {
    const newPrefix = prefix === "/" ? "" : prefix;

    return uri.with({
        path: `${newPrefix}/${filePath}`,
    });
}

export async function uriExists(uri: Uri): Promise<boolean> {
    if (uri.scheme === UNTITLED_SCHEME) {
        return true;
    }

    try {
        await workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await workspace.fs.stat(Uri.parse(filePath));
        return true;
    } catch {
        return false;
    }
}

export async function createDirectoryUri(uri: Uri): Promise<void> {
    return workspace.fs.createDirectory(uri);
}

export async function createDirectory(dir: string): Promise<void> {
    return workspace.fs.createDirectory(Uri.parse(dir));
}

export async function readFile(filePath: string): Promise<string> {
    const bytes = await workspace.fs.readFile(Uri.parse(filePath));
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

export async function readFileUri(uri: Uri): Promise<string> {
    const bytes = await workspace.fs.readFile(uri);
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

export async function readRAWFileUri(uri: Uri): Promise<string> {
    const bytes = await workspace.fs.readFile(uri);
    return new TextDecoder("utf-8").decode(bytes);
}

export async function writeFile(filePath: string, contents: string): Promise<void> {
    const writeData = new TextEncoder().encode(contents);
    await workspace.fs.writeFile(Uri.parse(filePath), writeData);
}

export async function writeFileUri(uri: Uri, contents: string): Promise<void> {
    const writeData = new TextEncoder().encode(contents);
    await workspace.fs.writeFile(uri, writeData);
}

export async function deleteFileUri(uri: Uri): Promise<void> {
    await workspace.fs.delete(uri, { recursive: false, useTrash: false });
}

export function parsePosition(position: string): Bookmark | undefined {
    const re = new RegExp(/\(Ln\s(\d+),\sCol\s(\d+)\)/);
    const matches = re.exec(position);
    if (matches) {
        return {
            line: parseInt(matches[1], 10),
            column: parseInt(matches[2], 10),
        };
    }
    return undefined;
}

export function getFileUri(file?: File, workspaceFolder?: WorkspaceFolder): Uri {
    if (file?.uri) {
        return file.uri;
    }

    if (!workspaceFolder) {
        return Uri.file(file?.path ?? "");

    }

    const prefix = workspaceFolder.uri.path.endsWith("/") ? workspaceFolder.uri.path : `${workspaceFolder.uri.path}/`;
    return uriWith(workspaceFolder.uri, prefix, file.path);
}

export function fileSystemData(wsFolder: WorkspaceFolder | string | undefined): FileSystemData {
    const workspaceFolder: WorkspaceFolder | undefined =
        typeof wsFolder === "object" || typeof wsFolder === "undefined"
            ? (wsFolder ?? Container.workspaceManager?.workspaceFolder ?? workspace.workspaceFolders?.[0])
            : workspace.getWorkspaceFolder(Uri.file(wsFolder));

    if (!workspaceFolder) {
        return {
            workspaceData: undefined,
            fileData: { bookmarks: [], path: "", uri: undefined },
            root: "",
            dir: "",
            base: "",
            ext: "",
            name: "",
        };
    }

    let wsBookmarks: Bookmark[] = [];
    let gsBookmarks: Bookmark[] = [];
    try {
        wsBookmarks = JSON.parse(Container.workspaceState.get("bookmarks", "[]"));
    } catch (e) {
        logger.error("workspaceState.fileSystemData", "Error parsing bookmarks from workspace state", e);
        window.showErrorMessage(l10n.t("Error loading Bookmarks: ") + e.toString());
    }
    try {
        gsBookmarks = JSON.parse(Container.globalState.get("globalBookmarks", "[]"));
    } catch (e) {
        logger.error("workspaceState.fileSystemData", "Error parsing bookmarks from global state", e);
        window.showErrorMessage(l10n.t("Error loading Global Bookmarks: ") + e.toString());
    }

    const fileData: File = {
        bookmarks: [...wsBookmarks, ...gsBookmarks].sort((a, b) => a.line - b.line),
        path: workspaceFolder.uri.fsPath,
        uri: workspaceFolder.uri,
    };
    const parsed: path.ParsedPath = path.parse(workspaceFolder.uri.fsPath);
    return {
        workspaceData: workspaceFolder,
        fileData: fileData,
        ...parsed
    };
}
