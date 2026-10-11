import { ThemeIcon, Uri } from "vscode";
import type { File } from "../core/file";
import { BaseNode } from "./nodes";

export class FileNode extends BaseNode<File> {
    constructor(...args: ConstructorParameters<typeof BaseNode<File>>) {
        super(...args);

        this.iconPath = ThemeIcon.File;
        this.contextValue = "BookmarkNodeFile";
        this.resourceUri = Uri.file(this.bookmark.path);
    }
}
