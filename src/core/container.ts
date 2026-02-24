/* eslint-disable @typescript-eslint/no-non-null-assertion */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Alessandro Fragnani. All rights reserved.
 *  Licensed under the GPLv3 License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext as ExtCtx, Memento } from "vscode";
import { GlobalBookmarksManager } from "../global/globalBookmarks";
import { Controller } from "./controller";

type KeyValueShape = Record<string, unknown>;

/**
 * Real keys currently persisted in workspaceState.
 * (These are key-value entries in Memento, not object properties.)
 */
export type WorkspaceStateShape = {
    bookmarks: string;
    defaultWorkspaceFolder: string;
};

/**
 * Real keys currently persisted in globalState.
 */
export type GlobalStateShape = {
    globalBookmarks: string;
    viewAsList: boolean;
    "bookmarks.sidebar.hidePosition": boolean;
};

class TypedMemento<TShape extends KeyValueShape> {
    protected readonly memento: Memento;

    constructor(memento: Memento) {
        this.memento = memento;
    }

    public get<K extends keyof TShape>(key: K, defaultValue: TShape[K]): TShape[K] {
        return this.memento.get(key as string, defaultValue);
    }

    public getOptional<K extends keyof TShape>(key: K): TShape[K] | undefined {
        return this.memento.get<TShape[K]>(key as string);
    }

    public update<K extends keyof TShape>(key: K, value: TShape[K]): Thenable<void> {
        return this.memento.update(key as string, value);
    }
}

class TypedGlobalMemento<TShape extends KeyValueShape> extends TypedMemento<TShape> {
    public setKeysForSync(keys: readonly (keyof TShape & string)[]): void {
        const syncable = this.memento as Memento & { setKeysForSync?: (keys: readonly string[]) => void };
        syncable.setKeysForSync?.(keys as readonly string[]);
    }
}

export type ExtensionContext = ExtCtx;

export class Container {
    private static _extContext: ExtensionContext | undefined;
    private static _workspaceState: TypedMemento<WorkspaceStateShape> | undefined;
    private static _globalState: TypedGlobalMemento<GlobalStateShape> | undefined;

    private static _globalManager: GlobalBookmarksManager | undefined;
    private static _workspaceManager: Controller | undefined;

    public static get workspaceManager(): Controller | undefined {
        return this._workspaceManager;
    }

    public static set workspaceManager(manager: Controller | undefined) {
        this._workspaceManager = manager;
    }

    public static get globalManager(): GlobalBookmarksManager {
        if (!this._globalManager) {
            this._globalManager = new GlobalBookmarksManager();
            this._globalManager.load();
        }
        return this._globalManager;
    }

    public static set globalManager(manager: GlobalBookmarksManager) {
        this._globalManager = manager;
    }

    public static get context(): ExtensionContext {
        this.assertInitialized();
        return this._extContext!;
    }

    public static set context(ec: ExtCtx) {
        this._extContext = ec as ExtensionContext;
        this._workspaceState = new TypedMemento<WorkspaceStateShape>(ec.workspaceState);
        this._globalState = new TypedGlobalMemento<GlobalStateShape>(ec.globalState);
    }

    public static get workspaceState(): TypedMemento<WorkspaceStateShape> {
        this.assertInitialized();
        return this._workspaceState!;
    }

    public static get globalState(): TypedGlobalMemento<GlobalStateShape> {
        this.assertInitialized();
        return this._globalState!;
    }

    private static assertInitialized(): void {
        if (!this._extContext || !this._workspaceState || !this._globalState) {
            throw new Error("Container.context is not initialized. Call `Container.context = context` in activate().");
        }
    }
}