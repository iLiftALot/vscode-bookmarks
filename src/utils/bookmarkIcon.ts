import { Uri, workspace } from "vscode";
import { DEFAULT_GUTTER_ICON_BORDER_COLOR, DEFAULT_GUTTER_ICON_FILL_COLOR } from "../core/constants";

export function createBookmarkIconUri(): Uri {
    const iconFillColor = workspace.getConfiguration("bookmarks").get(
        "gutterIconFillColor",
        DEFAULT_GUTTER_ICON_FILL_COLOR
    );
    const iconBorderColor = workspace.getConfiguration("bookmarks").get(
        "gutterIconBorderColor",
        DEFAULT_GUTTER_ICON_BORDER_COLOR
    );
    const iconPath = Uri.parse(
        `data:image/svg+xml,${
            encodeURIComponent(
                `<?xml version="1.0" ?><svg height="16px" version="1.1" viewBox="0 0 16 16" width="16px" xmlns="http://www.w3.org/2000/svg" xmlns:sketch="http://www.bohemiancoding.com/sketch/ns" xmlns:xlink="http://www.w3.org/1999/xlink"><title/><desc/><defs/><g fill="none" fill-rule="evenodd" id="Page-1" stroke="${iconBorderColor}" stroke-width="1"><g fill="${iconFillColor}" id="icon-18-bookmark"><path d="m6.6319,2.13334c-0.82764,0 -1.49857,0.67089 -1.49857,1.49555l0,10.50444l2.99999,-3l3,3l0,-10.50444c0,-0.82597 -0.67081,-1.49555 -1.49858,-1.49555l-3.00285,0z" id="bookmark"/></g></g></svg>`
            )
        }`
    );
    return iconPath;
}
