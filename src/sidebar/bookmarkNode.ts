import type { File } from "../core/file";
import { createBookmarkIconUri } from "../utils/bookmarkIcon";
import { BaseNode } from "./nodes";

// Preserve existing imports elsewhere in the project.
export type { BookmarkPreview } from "./nodes";

export class BookmarkNode extends BaseNode<File | null> {
    constructor(...args: ConstructorParameters<typeof BaseNode<File | null>>) {
        super(...args);

        this.iconPath = createBookmarkIconUri();
        this.contextValue = "BookmarkNodeBookmark";
    }
}
