/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { Command, TreeItem, TreeItemCollapsibleState, Uri } from "vscode";
import type { File } from "../core/file";

export interface BookmarkPreview {
    file: string;
    line: number;
    column: number;
    preview: string;
    uri: Uri;
}

export enum BookmarkNodeKind {
    NODE_FILE,
    NODE_BOOKMARK,
    NODE_WORKSPACE_FOLDER
}

export enum ViewAs {
    VIEW_AS_TREE,
    VIEW_AS_LIST
}

export class BaseNode<TFile extends File | null = File | null> extends TreeItem {
    constructor(
        public readonly label: string,
        public readonly relativePath: string | undefined,
        public readonly collapsibleState: TreeItemCollapsibleState,
        public readonly kind: BookmarkNodeKind,
        public readonly bookmark: TFile,
        public readonly books?: BookmarkPreview[],
        public readonly command?: Command
    ) {
        super(label, collapsibleState);
        this.description = relativePath;
    }
}
