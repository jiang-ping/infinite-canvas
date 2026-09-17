import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { withLocalProxy } from "@/stores/use-config-store";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    __xaisOutput?: unknown;
};

type ImageVariant = "thumb" | "webp" | "download";
type XaisOutputRegistry = Record<string, { taskId: string; att: string; thumb: string; webp: string; download: string }>;

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REMOTE_LOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";

type ImageReadOptions = { signal?: AbortSignal };

const IMAGE_ATT_PATTERN = /^([a-z0-9]{1,4})\/(\d{6})\/(\d+)\/([^/]+)$/;
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const IMAGE_SERVER_PREFIX = "/xais/img/";

/** 参考图条目形态:worker 脚本上传循环直接跳过,ref 直接复用原始附件 */
export const XAIS_ATT_PREFIX = "xais-att:";

/** 从签名 OSS URL / 图片服务器 URL / att 本身解析出附件名;不是 Xais 附件时返回 null。 */
export function xaisAttName(source: string | undefined | null) {
    if (!source) return null;
    if (source.startsWith(XAIS_ATT_PREFIX)) return source.slice(XAIS_ATT_PREFIX.length) || null;
    let candidate = source;
    if (/^https?:\/\//i.test(source)) {
        try {
            const parsed = new URL(source);
            candidate = parsed.pathname.startsWith(IMAGE_SERVER_PREFIX) ? parsed.pathname.slice(IMAGE_SERVER_PREFIX.length) : parsed.searchParams.get("att") || safeDecodeURIComponent(parsed.pathname);
        } catch {
            return null;
        }
    }
    const att = candidate.replace(/^\/+|\/+$/g, "");
    return IMAGE_EXT_PATTERN.test(att) && IMAGE_ATT_PATTERN.test(att) ? att : null;
}

function isXaisEmbedMode() {
    return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("embed") === "1";
}

function safeDecodeURIComponent(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Xais embed 兜底：仅当 OSS 签名地址直连失败（如响应被无 CORS 头的缓存污染）时，
 * 才改走同源 /xais/img 代理由后端回源取图；正常情况始终直接从 OSS 下载。
 */
function fallbackSameOriginImageUrl(url: string) {
    if (!isXaisEmbedMode()) return url;
    let candidate = url;
    if (/^https?:\/\//i.test(url)) {
        try {
            const parsed = new URL(url);
            if (parsed.origin === window.location.origin) return url;
            candidate = parsed.pathname.startsWith(IMAGE_SERVER_PREFIX) ? parsed.pathname.slice(IMAGE_SERVER_PREFIX.length) : parsed.searchParams.get("att") || safeDecodeURIComponent(parsed.pathname);
        } catch {
            return url;
        }
    } else {
        candidate = safeDecodeURIComponent(url);
    }
    const att = candidate.replace(/^\/+|\/+$/g, "");
    return IMAGE_EXT_PATTERN.test(att) && IMAGE_ATT_PATTERN.test(att) ? `${IMAGE_SERVER_PREFIX}${att}?op=download` : url;
}

function xaisOutputForUrl(url: string | undefined) {
    return url ? (globalThis as typeof globalThis & { __xaisCanvasOutputs?: XaisOutputRegistry }).__xaisCanvasOutputs?.[url] : undefined;
}

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const xaisOutput = typeof input === "string" ? xaisOutputForUrl(input) : undefined;
    if (typeof input !== "string") return storeImage(input, options);

    let blob: Blob;
    try {
        blob = await fetchImageBlob(input, options);
    } catch (error) {
        if (options?.signal?.aborted || isNamedError(error, IMAGE_RESPONSE_ERROR) || isNamedError(error, IMAGE_TIMEOUT_ERROR) || !/^https?:\/\//i.test(input)) throw error;
        const meta = await loadImageMeta(input, options, IMAGE_REMOTE_LOAD_TIMEOUT_MS);
        if (!meta) throw error;
        return { url: input, width: meta.width, height: meta.height, bytes: 0, mimeType: "", ...(xaisOutput ? { __xaisOutput: xaisOutput } : {}) };
    }
    const stored = await storeImage(blob, options);
    return xaisOutput ? { ...stored, __xaisOutput: xaisOutput } : stored;
}

async function storeImage(blob: Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const storageKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    try {
        const meta = await loadImageMeta(url, options);
        if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
        throwIfAborted(options?.signal);
        await store.setItem(storageKey, blob);
        throwIfAborted(options?.signal);
        objectUrls.set(storageKey, url);
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type.startsWith("image/") ? blob.type : "" };
    } catch (error) {
        URL.revokeObjectURL(url);
        await store.removeItem(storageKey).catch(() => undefined);
        throw error;
    }
}

async function downloadImageBlob(url: string, signal: AbortSignal) {
    // no-store：img 标签会以 no-cors 方式预载同一签名地址并把缺少 CORS 头的响应写入 HTTP 缓存
    // （OSS 不返回 Vary: Origin）；fetch 必须绕过缓存回源，OSS 才会按 Origin 返回 ACAO 头。
    const response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok) throw namedError(IMAGE_RESPONSE_ERROR);
    return await response.blob();
}

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        return await downloadImageBlob(withLocalProxy(url), controller.signal);
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted) throw abortReason(options.signal);
        const fallbackUrl = fallbackSameOriginImageUrl(url);
        if (fallbackUrl !== url && (isNamedError(error, IMAGE_RESPONSE_ERROR) || error instanceof TypeError)) {
            // 直连失败才回退到同源代理，避免服务器转发带宽
            return await downloadImageBlob(fallbackUrl, controller.signal);
        }
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function loadImageMeta(url: string, options?: ImageReadOptions, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
    return new Promise<{ width: number; height: number } | null>((resolve, reject) => {
        if (options?.signal?.aborted) return reject(abortReason(options.signal));
        const image = new Image();
        let settled = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options?.signal?.removeEventListener("abort", abort);
            image.onload = null;
            image.onerror = null;
            resolve(value);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            reject(abortReason(options!.signal!));
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        options?.signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

function namedError(name: string) {
    const error = new Error(i18n.t("common.imageReadFailed"));
    error.name = name;
    return error;
}

function isNamedError(error: unknown, name: string) {
    return error instanceof Error && error.name === name;
}

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal);
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

function remoteVariantKey(att: string, variant: ImageVariant) {
    return `image:remote:${variant}:${encodeURIComponent(att)}`;
}

/** Cache a server image variant so local-first drafts do not depend on expiring signed URLs. */
export async function cacheRemoteImageVariant(att: string, variant: ImageVariant, source?: string) {
    if (!source) return null;
    const storageKey = remoteVariantKey(att, variant);
    const cached = await store.getItem<Blob>(storageKey);
    if (cached) return { storageKey, url: await resolveImageUrl(storageKey) };
    try {
        const blob = await fetchImageBlob(source);
        await store.setItem(storageKey, blob);
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        return { storageKey, url };
    } catch {
        return null;
    }
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string; att?: string }, options?: ImageReadOptions) {
    // Xais embed:图片自带服务器附件名时返回 xais-att: 前缀条目,worker 脚本直接复用原 att,
    // 跳过图片下载与 fileAttachmentUploadUrl 重新上传;独立使用画布(无 worker 模型)保持原 data URL 语义。
    if (isXaisEmbedMode() && !image.dataUrl?.startsWith("data:")) {
        const att = xaisAttName(image.att);
        if (att) return XAIS_ATT_PREFIX + att;
    }
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchImageBlob(url, options));
}

/** Remove persisted blobs but keep active object URLs usable by the current iframe. */
export async function removeStoredImages(keys: Iterable<string>) {
    await Promise.all(Array.from(new Set(keys)).map((key) => store.removeItem(key)));
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
