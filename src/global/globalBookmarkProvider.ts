/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path = require("path");
import * as vscode from "vscode";
import { DEFAULT_GLOBAL_GUTTER_ICON_BORDER_COLOR, DEFAULT_GLOBAL_GUTTER_ICON_FILL_COLOR } from "../core/constants";
import { Container } from "../core/container";
import { GLOBAL_SIDEBAR_HIDE_POSITION, GlobalBookmarksManager, GlobalFile } from "./globalBookmarks";

// --- Tree Node types ---

class GlobalFileNode extends vscode.TreeItem {
    constructor(
        public readonly filePath: string,
        public readonly globalFile: GlobalFile,
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(path.basename(filePath), collapsibleState);
        this.resourceUri = vscode.Uri.file(filePath);
        this.description = path.dirname(filePath);
        this.iconPath = vscode.ThemeIcon.File;
        this.contextValue = "GlobalBookmarkNodeFile";
    }
}

class GlobalBookmarkNode extends vscode.TreeItem {
    constructor(
        label: string,
        description: string | undefined,
        public readonly filePath: string,
        public readonly line: number,
        public readonly column: number,
        public readonly uri: vscode.Uri,
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;

        const iconFillColor = vscode.workspace
            .getConfiguration("bookmarks")
            .get("gutterGlobalIconFillColor", DEFAULT_GLOBAL_GUTTER_ICON_FILL_COLOR);
        const iconBorderColor = vscode.workspace
            .getConfiguration("bookmarks")
            .get("gutterGlobalIconBorderColor", DEFAULT_GLOBAL_GUTTER_ICON_BORDER_COLOR);
        this.iconPath = vscode.Uri.parse(
            `data:image/svg+xml,${encodeURIComponent(
                `<?xml version="1.0" ?><svg height="16px" version="1.1" viewBox="0 0 16 16" width="16px" xmlns="http://www.w3.org/2000/svg" xmlns:sketch="http://www.bohemiancoding.com/sketch/ns" xmlns:xlink="http://www.w3.org/1999/xlink"><title/><desc/><defs/><g fill="none" fill-rule="evenodd" id="Page-1" stroke="${iconBorderColor}" stroke-width="1"><g fill="${iconFillColor}" id="icon-18-bookmark"><path d="m6.6319,2.13334c-0.82764,0 -1.49857,0.67089 -1.49857,1.49555l0,10.50444l2.99999,-3l3,3l0,-10.50444c0,-0.82597 -0.67081,-1.49555 -1.49858,-1.49555l-3.00285,0z" id="bookmark"/></g></g></svg>`,
            )}`,
        );
        this.contextValue = "GlobalBookmarkNodeBookmark";

        this.command = {
            command: "_bookmarks.jumpToGlobal",
            title: "",
            arguments: [filePath, line, column, uri],
        };
    }
}

// --- TreeDataProvider ---

export class GlobalBookmarkProvider implements vscode.TreeDataProvider<GlobalFileNode | GlobalBookmarkNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;

    constructor(private manager: GlobalBookmarksManager) {
        if (vscode.workspace.getConfiguration("bookmarks.sideBar").get<boolean>("expanded", false)) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        }

        manager.onDidChange(() => {
            this._onDidChangeTreeData.fire();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: GlobalFileNode | GlobalBookmarkNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: GlobalFileNode | GlobalBookmarkNode): Promise<(GlobalFileNode | GlobalBookmarkNode)[]> {
        if (!element) {
            // ROOT — return file nodes
            const files = this.manager.files.filter((f) => f.bookmarks.length > 0);
            if (files.length === 0) {
                return [];
            }
            return files.map((f) => new GlobalFileNode(f.path, f, this.collapsibleState));
        }

        if (element instanceof GlobalFileNode) {
            const hidePosition = Container.globalState.get(GLOBAL_SIDEBAR_HIDE_POSITION, false);
            const uri = vscode.Uri.file(element.filePath);
            const nodes: GlobalBookmarkNode[] = [];

            for (const bkm of element.globalFile.bookmarks) {
                let preview: string;
                if (bkm.label && bkm.label !== "") {
                    preview = "\u270E " + bkm.label;
                } else {
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        preview = doc.lineAt(bkm.line).text.trim();
                    } catch {
                        preview = `Line ${bkm.line + 1}`;
                    }
                }

                const desc = !hidePosition ? `(Ln ${bkm.line + 1}, Col ${bkm.column + 1})` : undefined;

                nodes.push(new GlobalBookmarkNode(preview, desc, element.filePath, bkm.line, bkm.column, uri));
            }
            return nodes;
        }

        return [];
    }
}

// --- Explorer wrapper ---

export class GlobalBookmarksExplorer {
    private treeView: vscode.TreeView<GlobalFileNode | GlobalBookmarkNode>;
    private provider: GlobalBookmarkProvider;

    constructor(private manager: GlobalBookmarksManager) {
        this.provider = new GlobalBookmarkProvider(manager);
        this.treeView = vscode.window.createTreeView("bookmarksGlobalExplorer", {
            treeDataProvider: this.provider,
            showCollapseAll: true,
        });

        manager.onDidChange(() => {
            this.updateBadge();
        });
    }

    getProvider(): GlobalBookmarkProvider {
        return this.provider;
    }

    updateBadge(): void {
        const count = this.manager.countBookmarks();
        const tooltip = count === 0 ? "" : count === 1 ? "1 global bookmark" : `${count} global bookmarks`;
        this.treeView.badge = { value: count, tooltip };
    }

    dispose(): void {
        this.treeView.dispose();
    }
}
