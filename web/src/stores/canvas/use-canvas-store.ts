import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import { isXaisEmbed, loadXaisCanvasProject, syncXaisModels, xaisCanvasStorageKey, xaisFileId } from "@/services/xais-embed";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects" | "deletedProjects">;
let queuedPersistState: PersistedCanvasState | null = null;
let xaisSaveTimer: ReturnType<typeof setTimeout> | null = null;

const xaisSaveMarker = () => `xais-canvas-saved:${xaisFileId()}`;

/** Cancel a pending draft write before deleting the draft after a successful server save. */
export async function clearXaisCanvasDraft() {
    if (xaisSaveTimer) {
        clearTimeout(xaisSaveTimer);
        xaisSaveTimer = null;
    }
    queuedPersistState = null;
    await localForageStorage.removeItem(xaisCanvasStorageKey());
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const embed = isXaisEmbed();
        // A new iframe instance is allowed to persist again after it has loaded the saved server state.
        if (embed && typeof sessionStorage !== "undefined") sessionStorage.removeItem(xaisSaveMarker());
        const storageKey = embed ? xaisCanvasStorageKey() : name;
        const value = await localForageStorage.getItem(storageKey);
        if (value) {
            const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
            queuedPersistState = parsed.state as PersistedCanvasState;
            // 本地草稿优先：有草稿时不请求服务器，也不以服务器数据覆盖用户未保存的修改。
            // 但模型调用脚本会随版本更新，不能沿用持久化下来的旧脚本（旧脚本可能多传 fileId 等字段），
            // 因此这里补一次后台同步，只刷新渠道/脚本，不覆盖本地草稿。
            if (embed) void syncXaisModels().catch(() => {});
            return parsed;
        }
        if (embed) {
            // 只有当前文件没有本地草稿时才从服务器兜底加载。
            const project = await loadXaisCanvasProject();
            const storageValue = { state: { projects: [project], deletedProjects: [] }, version: 0 } as unknown as StorageValue<CanvasStore>;
            queuedPersistState = storageValue.state as PersistedCanvasState;
            return storageValue;
        }
        return null;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects && queuedPersistState.deletedProjects === nextState.deletedProjects) return;
        queuedPersistState = nextState;
        if (xaisSaveTimer) clearTimeout(xaisSaveTimer);
        xaisSaveTimer = setTimeout(() => {
            xaisSaveTimer = null;
            if (isXaisEmbed() && typeof sessionStorage !== "undefined" && sessionStorage.getItem(xaisSaveMarker()) === "1") return;
            void localForageStorage.setItem(isXaisEmbed() ? xaisCanvasStorageKey() : name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(isXaisEmbed() ? xaisCanvasStorageKey() : name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                }),
            replaceProjects: (projects, deletedProjects = []) => set({ projects, deletedProjects }),
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    deletedProjects: state.deletedProjects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
