/*---------------------------------------------------------------------------------------------
*  Copyright (c) Alessandro Fragnani. All rights reserved.
*  Licensed under the GPLv3 License. See License.md in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Directions, NO_BOOKMARKS_AFTER, NO_BOOKMARKS_BEFORE, NO_MORE_BOOKMARKS } from "../../core/constants";
import { Controller } from "../../core/controller";
import { File, createFile } from "../../core/file";

suite("Controller navigation", () => {
    let directory: string;
    let originalWrapNavigation: boolean | undefined;

    suiteSetup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "bookmarks-navigation-"));
        await fs.writeFile(path.join(directory, "first.txt"), "first\n");
        await fs.writeFile(path.join(directory, "last.txt"), "last\n");
    });

    setup(async () => {
        const configuration = vscode.workspace.getConfiguration("bookmarks");
        originalWrapNavigation = configuration.inspect<boolean>("wrapNavigation")?.globalValue;
        await configuration.update("wrapNavigation", true, vscode.ConfigurationTarget.Global);
    });

    teardown(async () => {
        await vscode.workspace.getConfiguration("bookmarks").update(
            "wrapNavigation",
            originalWrapNavigation,
            vscode.ConfigurationTarget.Global
        );
    });

    suiteTeardown(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    function file(name: string, bookmarked = true): File {
        const result = createFile(path.join(directory, name));
        if (bookmarked) {
            result.bookmarks.push({ line: 0, column: 0 });
        }
        return result;
    }

    test("skips empty and missing files in both directions", async () => {
        const controller = new Controller(undefined);
        const first = file("first.txt");
        const last = file("last.txt");
        controller.files = [ first, file("empty.txt", false), file("missing.txt"), last ];

        assert.strictEqual(await controller.nextDocumentWithBookmarks(first, Directions.Forward), last.path);
        assert.strictEqual(await controller.nextDocumentWithBookmarks(last, Directions.Backward), first.path);
    });

    test("wraps in both directions", async () => {
        const controller = new Controller(undefined);
        const first = file("first.txt");
        const last = file("last.txt");
        controller.files = [ first, last ];

        assert.strictEqual(await controller.nextDocumentWithBookmarks(last, Directions.Forward), first.path);
        assert.strictEqual(await controller.nextDocumentWithBookmarks(first, Directions.Backward), last.path);
    });

    test("can wrap back to the starting file", async () => {
        const controller = new Controller(undefined);
        const first = file("first.txt");
        controller.files = [ first, file("missing.txt") ];

        assert.strictEqual(await controller.nextDocumentWithBookmarks(first, Directions.Forward), first.path);
    });

    test("returns untitled URIs without a filesystem lookup", async () => {
        const controller = new Controller(undefined);
        const first = file("first.txt");
        const uri = vscode.Uri.parse("untitled:Untitled-1");
        const untitled = createFile(uri.path, uri);
        untitled.bookmarks.push({ line: 0, column: 0 });
        controller.files = [ first, untitled ];

        assert.strictEqual(await controller.nextDocumentWithBookmarks(first, Directions.Forward), uri);
    });

    test("stops after one pass when all bookmarked files are missing", async () => {
        const controller = new Controller(undefined);
        const first = file("missing-first.txt");
        const second = file("missing-second.txt");
        controller.files = [ first, second ];
        controller.activeFile = file("different-active.txt");
        const visited: File[] = [];
        const getFileUri = controller.getFileUri.bind(controller);
        controller.getFileUri = (candidate) => {
            visited.push(candidate);
            return getFileUri(candidate);
        };

        assert.strictEqual(await controller.nextDocumentWithBookmarks(first, Directions.Forward), NO_MORE_BOOKMARKS);
        assert.deepStrictEqual(visited, [ second, first ]);
    });

    test("uses the captured list when active state changes during a lookup", async () => {
        const controller = new Controller(undefined);
        const first = file("first.txt");
        const last = file("last.txt");
        controller.files = [ first, file("missing.txt"), last ];
        controller.activeFile = first;

        const result = controller.nextDocumentWithBookmarks(first, Directions.Forward);
        controller.activeFile = undefined;
        controller.files = [];

        assert.strictEqual(await result, last.path);
    });

    test("handles empty files and unknown starting files", async () => {
        const controller = new Controller(undefined);
        const empty = file("empty.txt", false);
        assert.strictEqual(await controller.nextDocumentWithBookmarks(empty, Directions.Forward), NO_MORE_BOOKMARKS);

        controller.files = [ empty ];
        assert.strictEqual(await controller.nextDocumentWithBookmarks(empty, Directions.Backward), NO_MORE_BOOKMARKS);
        assert.strictEqual(
            await controller.nextDocumentWithBookmarks(file("other.txt"), Directions.Forward),
            NO_MORE_BOOKMARKS
        );
    });

    test("preserves no-wrap boundary rejections", async () => {
        await vscode.workspace.getConfiguration("bookmarks").update(
            "wrapNavigation",
            false,
            vscode.ConfigurationTarget.Global
        );
        const controller = new Controller(undefined);
        const first = file("first.txt");
        const last = file("last.txt");
        controller.files = [ first, last ];

        assert.strictEqual(await controller.nextDocumentWithBookmarks(first, Directions.Forward), last.path);
        await assert.rejects(
            controller.nextDocumentWithBookmarks(last, Directions.Forward),
            (error: unknown) => error === NO_BOOKMARKS_AFTER
        );
        await assert.rejects(
            controller.nextDocumentWithBookmarks(first, Directions.Backward),
            (error: unknown) => error === NO_BOOKMARKS_BEFORE
        );
    });
});

suite("Controller storage", () => {
    test("loads v1, v2 and v3 storage formats", () => {
        const bookmarks = [ { line: 0, column: 2, label: "label" } ];
        const legacyFile = { path: `$ROOTPATH$${path.sep}saved.ts`, bookmarks };
        const currentFile = { path: "saved.ts", bookmarks };

        for (const data of [ { bookmarks: [ legacyFile ] }, [ legacyFile ], { files: [ currentFile ] } ]) {
            const controller = new Controller(undefined);
            controller.loadFrom(data, true);
            assert.deepStrictEqual(controller.files.map((file) => ({ path: file.path, bookmarks: file.bookmarks })), [
                currentFile
            ]);
            assert.notStrictEqual(controller.files[0].bookmarks[0], bookmarks[0]);
        }
    });

    test("loads folderless absolute paths and ignores legacy untitled files", () => {
        const controller = new Controller(undefined);
        const absolutePath = path.join(os.tmpdir(), "saved.ts");
        controller.loadFrom([
            { path: absolutePath, bookmarks: [ { line: 0, column: 0 } ] },
            { path: "Untitled-1", bookmarks: [ { line: 0, column: 0 } ] }
        ]);

        assert.strictEqual(controller.files.length, 1);
        assert.strictEqual(controller.files[0].path, absolutePath);
    });

    test("rejects malformed storage before changing existing files", () => {
        const controller = new Controller(undefined);
        const existing = createFile("existing.ts");
        controller.files = [ existing ];

        assert.throws(() =>
            controller.loadFrom({
                files: [
                    { path: "valid.ts", bookmarks: [ { line: 0, column: 0 } ] },
                    { path: "invalid.ts", bookmarks: [ { line: "invalid", column: 0 } ] }
                ]
            }), TypeError);
        assert.deepStrictEqual(controller.files, [ existing ]);
        assert.throws(() => controller.loadFrom(null), TypeError);
        controller.loadFrom("");
        assert.deepStrictEqual(controller.files, [ existing ]);
    });

    test("serializes a detached plain snapshot without empty or untitled files", () => {
        const controller = new Controller(undefined);
        const saved = createFile("saved.ts");
        saved.bookmarks.push({ line: 0, column: 1, label: "label" });
        const untitled = createFile("Untitled-1", vscode.Uri.parse("untitled:Untitled-1"));
        untitled.bookmarks.push({ line: 0, column: 0 });
        controller.files = [ saved, createFile("empty.ts"), untitled ];

        const snapshot = controller.zip();
        assert.deepStrictEqual(snapshot, { files: [ { path: "saved.ts", bookmarks: saved.bookmarks } ] });
        assert.strictEqual(Object.getPrototypeOf(snapshot), Object.prototype);
        snapshot.files[0].bookmarks[0].label = "changed";
        assert.strictEqual(saved.bookmarks[0].label, "label");

        const restored = new Controller(undefined);
        restored.loadFrom(JSON.parse(JSON.stringify(controller.zip())));
        assert.deepStrictEqual(restored.zip(), controller.zip());
    });
});
