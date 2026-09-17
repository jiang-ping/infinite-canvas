import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, ViewportTransform } from '@/types/canvas';
import { useCanvasStore } from '@/stores/canvas/use-canvas-store';
import type { CanvasProject } from '@/stores/canvas/use-canvas-store';
import type { CanvasBackgroundMode } from '@/lib/canvas-theme';
import { localForageStorage } from '@/lib/localforage-storage';
import { XAIS_ATT_PREFIX, xaisAttName } from '@/services/image-storage';
import {
  encodeChannelModel,
  normalizeChannelModels,
  useConfigStore,
  type ModelCapability,
  type ModelChannel,
} from '@/stores/use-config-store';

export const XAIS_EMBED_VERSION = 1;
export const isXaisEmbed = () => new URLSearchParams(window.location.search).get('embed') === '1';
export const xaisFileId = () =>
  new URLSearchParams(window.location.search).get('fileId') || window.location.pathname.split('/').filter(Boolean).at(-1) || '';

export { XAIS_ATT_PREFIX, xaisAttName };

type RemotePage = {
  id: string;
  prompt?: string;
  ref?: string[];
  model?: string;
  custom_field?: Record<string, unknown>;
  tasks?: string[];
};

type RemoteTask = {
  sid: string;
  result?: string[];
  error?: string;
  state?: string;
};

export type XaisOutput = {
  taskId: string;
  att: string;
  thumb: string;
  webp: string;
  download: string;
};

type XaisOutputRegistry = Record<string, XaisOutput>;

declare global {
  // eslint-disable-next-line no-var
  var __xaisCanvasOutputs: XaisOutputRegistry | undefined;
}

export function getXaisOutputForUrl(url?: string) {
  return url ? globalThis.__xaisCanvasOutputs?.[url] : undefined;
}

type RemoteModel = {
  name: string;
  label?: string;
  type?: string;
  customSelectFields?: Array<{
    fieldName: string;
    fieldLabel: string;
    fieldTip?: string;
    options: Array<{ label?: string; value: string }>;
  }>;
  promptEnhance?: string;
};

type RemoteFile = {
  id: number;
  label: string;
  pages: RemotePage[];
  tasks?: RemoteTask[];
  models?: RemoteModel[];
  assets?: Record<string, unknown>;
  imageUrl?: { thumb: Record<string, string>; webp: Record<string, string>; download: Record<string, string> };
};

type XaisCanvasAssets = {
  version: number;
  items?: unknown[];
  canvas?: {
    connections?: CanvasConnection[];
    viewport?: ViewportTransform;
    backgroundMode?: CanvasBackgroundMode;
    showImageInfo?: boolean;
    chatSessions?: unknown[];
    activeChatId?: string | null;
  };
};

// ---- 模型同步：把 fileGetV2 返回的 models 注入画布配置，作为唯一的 Xais 渠道 ----

const XAIS_CHANNEL_ID = 'xais';

// 构建统一 Worker 任务脚本（每个模型注入各自支持的 customSelectField 定义）
// 只把模型支持的 customSelectField 参数发给 workerTaskStart，避免无效参数报错
// 单候选值字段不展示下拉框，但这里仍会带上其唯一候选值发送
export function buildWorkerScript(customSelectFields: Array<{ fieldName: string; options: Array<{ value: string }> }>): string {
  const fieldDefs = JSON.stringify(customSelectFields.map(f => ({ fieldName: f.fieldName, options: f.options.map(o => o.value) })));
  return [
    '// Xais Worker: workerTaskStart + workerTaskWait',
    'const XAIS_ATT_PREFIX = ' + JSON.stringify(XAIS_ATT_PREFIX) + ';',
    '// 1. 收集参考图:images 参数 + 文本模型 messages 里的 image_url(画布把参考图放在 vision content 中)',
    'const dataUrls = [...(images || [])];',
    'const isText = Array.isArray(messages) && messages.length > 0;',
    'if (isText) {',
    '  for (const msg of messages) {',
    '    if (!Array.isArray(msg.content)) continue;',
    '    for (const part of msg.content) {',
    '      const url = part && part.type === "image_url" && part.image_url && part.image_url.url;',
    '      if (typeof url === "string" && url) dataUrls.push(url);',
    '    }',
    '  }',
    '}',
    '// 2. 上传参考图（data URL → 附件名 → ref）；xais-att: 前缀的条目是服务器已有附件，直接复用不再上传',
    'const ref = [];',
    'for (const dataUrl of dataUrls) {',
    '  if (String(dataUrl).startsWith(XAIS_ATT_PREFIX)) { ref.push(String(dataUrl).slice(XAIS_ATT_PREFIX.length)); continue; }',
    '  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);',
    '  if (!match) continue;',
    '  const ext = match[1].split("/")[1] || "bin";',
    '  const bin = atob(match[2]);',
    '  const bytes = new Uint8Array(bin.length);',
    '  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);',
    '  const blob = new Blob([bytes], { type: match[1] });',
    '  const ticket = await (await fetch("/xais/fileAttachmentUploadUrl?ext=" + encodeURIComponent(ext), { credentials: "same-origin", signal })).json();',
    '  await fetch(ticket.url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob, signal });',
    '  ref.push(ticket.name);',
    '}',
    '// 3. 构建 custom_field（与界面显示一致：每个字段必带一个合法值）',
    '// params 已合并节点上的 xaisFields（fieldName → 用户所选值，原始字符串不做归一化转换）；',
    '// 值非法/缺失时回退首项（与 UI 未选择时显示首项的行为一致），避免服务端收不到参数',
    'const fieldDefs = ' + fieldDefs + ';',
    'const custom_field = {};',
    'const alias = { ratio: params?.size };',
    'for (const def of fieldDefs) {',
    '  let raw = params?.[def.fieldName];',
    '  if (raw === undefined || raw === null || raw === "") raw = alias[def.fieldName];',
    '  // 选项值可能是数字(kvconf 里 duration 等写成 60/120),而画布传来的是字符串 → 按 String 归一匹配;',
    '  // 命中时回填原始 option 值(保持数字类型),避免服务端按 === 校验候选值失败',
    '  const hit = def.options.find((o) => String(o) === String(raw));',
    '  custom_field[def.fieldName] = hit !== undefined ? hit : def.options[0];',
    '}',
    '// 4. 构建请求体',
    'const fileId = new URLSearchParams(window.location.search).get("fileId") || "";',
    'const pageId = params?.__xaisPageId || "";',
    'const reqBody = { model, prompt, ref, custom_field, fileId: Number(fileId) || undefined, pageId, client: "XAIS" };',
    '// 文本模型需要 t2tBody（OpenAI chat completions 格式 JSON）；参考图已走 ref，这里剔除 image_url 部分',
    'if (isText) {',
    '  const cleanMessages = messages.map((msg) => Array.isArray(msg.content)',
    '    ? { ...msg, content: msg.content.filter((p) => !(p && p.type === "image_url")).map((p) => (p && p.type === "text" ? p.text : "")).filter(Boolean).join("\\n") }',
    '    : msg);',
    '  reqBody.t2tBody = JSON.stringify({ model, messages: cleanMessages, stream: false });',
    '}',
    '// 5. 启动任务',
    'const startResp = await fetch("/xais/workerTaskStart", {',
    '  method: "POST",',
    '  headers: { "Content-Type": "application/json" },',
    '  credentials: "same-origin",',
    '  body: JSON.stringify(reqBody),',
    '  signal,',
    '});',
    'if (!startResp.ok) { const errBody = await startResp.text(); throw new Error("任务创建失败(" + startResp.status + "): " + errBody); }',
    'const taskId = await startResp.text();',
    'if (!taskId) throw new Error("任务创建失败");',
    '// 6. SSE 等待结果：长任务（如视频）的 SSE 长连接可能被 Cloudflare/网络中断；',
    '// workerTaskWait 按 taskId 幂等（服务端先查库，已完成立即返回），因此断线后等 5 秒重连，直到拿到 result/error',
    'let taskResult;',
    'const waitDeadline = Date.now() + 3600 * 1000;',
    'while (!taskResult) {',
    '  try {',
    '    const waitResp = await fetch("/xais/workerTaskWait?id=" + encodeURIComponent(taskId), { credentials: "same-origin", signal });',
    '    if (!waitResp.ok) throw new Error("任务等待失败: " + waitResp.status);',
    '    const reader = waitResp.body.getReader();',
    '    const decoder = new TextDecoder();',
    '    let buffer = "";',
    '    while (true) {',
    '      const chunk = await reader.read();',
    '      if (chunk.done) break;',
    '      buffer += decoder.decode(chunk.value, { stream: true });',
    '      const lines = buffer.split("\\n");',
    '      for (const line of lines) {',
    '        if (!line.startsWith("data:")) continue;',
    '        try {',
    '          const value = JSON.parse(line.slice(5).trim());',
    '          // 服务端等待超时(error=timeout)不代表任务失败，忽略并继续重连等待',
    '          if ((value.result || value.error) && value.error !== "timeout") { taskResult = value; break; }',
    '        } catch {}',
    '      }',
    '      buffer = lines[lines.length - 1] || "";',
    '      if (taskResult) break;',
    '    }',
    '  } catch (e) {',
    '    if (signal?.aborted) throw e;',
    '  }',
    '  if (!taskResult) {',
    '    if (Date.now() > waitDeadline) throw new Error("任务等待超时");',
    '    await sleep(5000, signal);',
    '  }',
    '}',
    'if (taskResult.error) throw new Error(taskResult.error);',
    'if (!taskResult.result?.length) throw new Error("任务未返回结果");',
    '// 7. 返回结果',
    'if (isText) {',
    '  // 文本：result[0] 是 OpenAI 响应 JSON 字符串',
    '  try {',
    '    const data = JSON.parse(taskResult.result[0]);',
    '    return data?.choices?.[0]?.message?.content || taskResult.result[0];',
    '  } catch { return taskResult.result[0]; }',
    '}',
    '// 图片/视频/音频：result 是附件名数组，获取三种 URL；只把 URL 返回给画布，真正媒体按需加载',
    'const outputs = await Promise.all(taskResult.result.map(async (att) => {',
    '  const r = await fetch("/xais/attUrls?att=" + encodeURIComponent(att), { credentials: "same-origin", signal });',
    '  const d = await r.json();',
    '  return { att, thumb: d.thumb, webp: d.webp, download: d.download };',
    '}));',
    'const registry = globalThis.__xaisCanvasOutputs || (globalThis.__xaisCanvasOutputs = {});',
    'for (const output of outputs) {',
    '  registry[output.webp || output.download || output.thumb] = { taskId, att: output.att, thumb: output.thumb, webp: output.webp, download: output.download };',
    '}',
    'return outputs.length === 1 ? { url: outputs[0].webp || outputs[0].thumb || outputs[0].download, taskId, att: outputs[0].att, thumb: outputs[0].thumb, webp: outputs[0].webp, download: outputs[0].download } : outputs.map((output) => ({ url: output.webp || output.thumb || output.download, taskId, att: output.att, thumb: output.thumb, webp: output.webp, download: output.download }));',
  ].join('\n');
}

function xaisCapabilityOf(type: string | undefined): ModelCapability | null {
  if (type === 't2i' || type === 'ti2i') return 'image';
  if (type === 't2v' || type === 'ti2v') return 'video';
  // ti2t = 支持图片输入的文生文,与 t2t 一样按 text 能力暴露(vision 标记区分)
  if (type === 't2t' || type === 'ti2t') return 'text';
  if (type === 't2a') return 'audio';
  return null;
}

/**
 * 把服务端返回的模型列表注入画布的渠道配置。
 * 所有模型统一使用 workerTaskStart + workerTaskWait 调用（中转站统一调度计费），
 * 不走 OpenAI /v1/images/* 或 Seedance 等格式 API。
 * 嵌入模式不需要用户手动配置 baseUrl/apiKey，同源 cookie 即完成鉴权。
 */
export function syncXaisModelsToConfig(models: RemoteModel[] | undefined) {
  const usable = (models || []).filter(item => item.name && xaisCapabilityOf(item.type));
  if (!usable.length) return;
  const channelModels = normalizeChannelModels(
    usable.map(item => {
      const capability = xaisCapabilityOf(item.type)!;
      return {
        name: item.name,
        label: item.label,
        customSelectFields: item.customSelectFields,
        promptEnhance: item.promptEnhance,
        capability,
        vision: item.type === 'ti2t', // 支持图片输入的文生文(反推提示词等场景只列这些)
        script: buildWorkerScript(item.customSelectFields || []),
      };
    }),
  );
  const channel: ModelChannel = {
    id: XAIS_CHANNEL_ID,
    name: 'Xais',
    baseUrl: window.location.origin,
    apiKey: 'xais-embed',
    apiFormat: 'openai',
    models: channelModels,
  };
  const firstOf = (capability: ModelCapability) => {
    const model = channelModels.find(item => item.capability === capability);
    return model ? encodeChannelModel(channel.id, model.name) : '';
  };
  const { config } = useConfigStore.getState();
  useConfigStore.setState({
    config: {
      ...config,
      channels: [channel],
      models: channelModels.map(item => encodeChannelModel(channel.id, item.name)),
      imageModel: firstOf('image') || config.imageModel,
      videoModel: firstOf('video') || config.videoModel,
      textModel: firstOf('text') || config.textModel,
      audioModel: firstOf('audio') || config.audioModel,
      canvasImageCount: '1', // XAIS worker 每次只生成1张，避免多次 workerTaskStart
    },
  });
}

const json = async <T>(url: string, init?: RequestInit) => {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error('Xais API ' + response.status + ': ' + url);
  return (await response.json()) as T;
};

export async function getXaisFile(fileId = xaisFileId()) {
  return json<RemoteFile>('/xais/fileGetV2?id=' + encodeURIComponent(fileId));
}

export async function enhanceXaisPrompt(model: string, prompt: string, ref: string[] = []) {
  const result = await json<{ prompt?: string }>('/xais/filePromptEnhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model.replace(/^xais::/, ''), prompt, ref }),
  });
  return result.prompt || '';
}


export async function updateXaisFile(body: Record<string, unknown>) {
  await json<void>('/xais/fileUpdate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function uploadXaisAttachment(blob: Blob, extension = 'bin') {
  const ticket = await json<{ url: string; name: string }>('/xais/fileAttachmentUploadUrl?ext=' + encodeURIComponent(extension));
  const upload = await fetch(ticket.url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  if (!upload.ok) throw new Error('附件上传失败: ' + upload.status);
  return ticket.name;
}

const attachmentUrls = new Map<string, { thumb: string; webp: string; download: string }>();
export async function getXaisAttachmentUrls(att: string) {
  const cached = attachmentUrls.get(att);
  if (cached) return cached;
  const result = await json<{ thumb: string; webp: string; download: string }>('/xais/attUrls?att=' + encodeURIComponent(att));
  attachmentUrls.set(att, result);
  return result;
}

export async function startXaisTask(request: {
  fileId?: string;
  pageId: string;
  model: string;
  prompt: string;
  ref?: string[];
  custom_field?: Record<string, unknown>;
  t2tBody?: string;
}) {
  return json<string>('/xais/workerTaskStart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, fileId: request.fileId || xaisFileId(), custom_field: request.custom_field || {}, client: 'XAIS' }),
  });
}

export async function waitXaisTask(
  taskId: string,
  { onThinking }: { onThinking?: (msg: string) => void } = {},
): Promise<{ result?: string[]; error?: string } | undefined> {
  const controller = new AbortController();
  const signal = controller.signal;
  const response = await fetch('/xais/workerTaskWait?id=' + encodeURIComponent(taskId), { credentials: 'same-origin', signal });
  if (!response.ok || !response.body) throw new Error('任务等待失败: ' + response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: { result?: string[]; error?: string } | undefined;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        const value = JSON.parse(line.slice(5).trim());
        if (value.result || value.error) result = value;
        else if (value.msg) onThinking?.(value.msg);
      } catch {
        // SSE may split a JSON record across chunks; the next read will retry the remainder.
      }
    }
    buffer = lines[lines.length - 1] ?? '';
  }
  return result;
}

const XAIS_MODEL_PREFIX = 'xais::';

function storedModelName(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model) return undefined;
  return model.startsWith(XAIS_MODEL_PREFIX) ? model.slice(XAIS_MODEL_PREFIX.length) : model;
}

function canvasModelName(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model) return undefined;
  return model.startsWith(XAIS_MODEL_PREFIX) ? model : XAIS_MODEL_PREFIX + model;
}

function nodeFromPage(page: RemotePage, taskById: Map<string, RemoteTask>, imageUrl: NonNullable<RemoteFile['imageUrl']>): CanvasNodeData {
  const custom = page.custom_field || {};
  const stored = (custom.xaisCanvas as { node?: Partial<CanvasNodeData> } | undefined)?.node;
  const taskId = page.tasks?.at(-1);
  const task = taskId ? taskById.get(taskId) : undefined;
  const att = task?.result?.at(-1);
  const mediaUrls = att
    ? { taskId, att, thumbUrl: imageUrl.thumb[att], webpUrl: imageUrl.webp[att], downloadUrl: imageUrl.download[att] }
    : {};
  // 新格式不再保存 node.id，页面外层 page.id 是唯一来源；同时兼容旧格式。
  if (stored?.position && stored.type) {
    const model = canvasModelName(page.model);
    const compactImages = stored.type === 'image' && Array.isArray((stored as { images?: unknown }).images)
      ? ((stored as { images: Array<Record<string, unknown>> }).images)
          .filter(image => typeof image.att === 'string' && image.att)
          .map(image => {
            const att = image.att as string;
            return {
              id: att,
              att,
              status: image.status === 'error' ? 'error' : image.status === 'loading' ? 'loading' : 'success',
              naturalWidth: Number(image.naturalWidth) || 0,
              naturalHeight: Number(image.naturalHeight) || 0,
              bytes: Number(image.bytes) || 0,
              mimeType: '',
              content: imageUrl.thumb[att],
              thumbUrl: imageUrl.thumb[att],
              webpUrl: imageUrl.webp[att],
              downloadUrl: imageUrl.download[att],
            };
          })
      : undefined;
    const metadata = (stored.metadata ? { ...stored.metadata } : {
      ...(compactImages ? { images: compactImages } : {}),
      ...(typeof (stored as { size?: unknown }).size === 'string' ? { size: (stored as { size: string }).size } : {}),
      ...(typeof (stored as { quality?: unknown }).quality === 'string' ? { quality: (stored as { quality: string }).quality } : {}),
      ...(typeof (stored as { primaryImageId?: unknown }).primaryImageId === 'string'
        ? { primaryImageId: compactImages?.some(image => image.id === (stored as { primaryImageId: string }).primaryImageId) ? (stored as { primaryImageId: string }).primaryImageId : compactImages?.[0]?.id }
        : {}),
    }) as CanvasNodeMetadata;
    if (page.prompt !== undefined) metadata.prompt = page.prompt;
    if (model !== undefined) metadata.model = model;
    metadata.references = page.ref || [];
    if (stored.type === 'image') metadata.generationType = page.ref?.length ? 'edit' : 'generation';
    Object.assign(metadata, mediaUrls);
    const primary = metadata.images?.find(image => image.id === metadata.primaryImageId) || metadata.images?.[0];
    if (primary?.content) {
      metadata.content = primary.content;
      metadata.storageKey = primary.storageKey;
      metadata.naturalWidth = primary.naturalWidth;
      metadata.naturalHeight = primary.naturalHeight;
      metadata.bytes = primary.bytes;
      metadata.mimeType = primary.mimeType;
      metadata.att = primary.att;
    } else if (mediaUrls.thumbUrl && stored.type === 'image') metadata.content = mediaUrls.thumbUrl;
    else if (mediaUrls.thumbUrl && (stored.type === 'video' || stored.type === 'audio')) delete metadata.content;
    return {
      id: page.id,
      type: stored.type,
      title: page.prompt || 'Canvas Node',
      position: stored.position,
      width: stored.width,
      height: stored.height,
      metadata,
    } as CanvasNodeData;
  }
  const metadata = ((custom.xaisCanvas as { metadata?: Record<string, unknown> } | undefined)?.metadata ||
    {}) as CanvasNodeData['metadata'];
  const model = canvasModelName(page.model ?? metadata?.model);
  return {
    id: page.id,
    type: (custom.canvasNodeType as CanvasNodeData['type']) || 'image',
    title: (custom.canvasTitle as string) || page.prompt || 'Canvas Node',
    position: (custom.canvasPosition as { x: number; y: number }) || { x: 0, y: 0 },
    width: (custom.canvasWidth as number) || 320,
    height: (custom.canvasHeight as number) || 320,
    metadata: { ...metadata, prompt: page.prompt, ...(model ? { model } : {}), references: page.ref || [], ...mediaUrls, ...(mediaUrls.thumbUrl && (custom.canvasNodeType === 'image') ? { content: mediaUrls.thumbUrl } : {}) },
  };
}

export async function remoteFileToProject(file: RemoteFile): Promise<CanvasProject> {
  syncXaisModelsToConfig(file.models);
  const saved = (file.assets?.xaisCanvas || {}) as XaisCanvasAssets;
  const canvas = saved.canvas || {};
  const taskById = new Map((file.tasks || []).map(task => [task.sid, task]));
  const imageUrl = file.imageUrl || { thumb: {}, webp: {}, download: {} };
  return {
    id: String(file.id),
    title: file.label,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: (file.pages || []).map(page => nodeFromPage(page, taskById, imageUrl)),
    connections: canvas.connections || [],
    chatSessions: (canvas.chatSessions || []) as CanvasProject['chatSessions'],
    activeChatId: canvas.activeChatId || null,
    backgroundMode: canvas.backgroundMode || 'lines',
    showImageInfo: Boolean(canvas.showImageInfo),
    viewport: canvas.viewport || { x: 0, y: 0, k: 1 },
  };
}

export async function loadXaisCanvasProject() {
  return remoteFileToProject(await getXaisFile());
}

function nodeForPageStorage(node: CanvasNodeData) {
  // 页面外层单独保存 id/prompt/model；图片附件只保存 att 和必要的尺寸信息。
  const metadata = node.metadata || {};
  const images = node.type === 'image'
    ? (metadata.images || []).map(image => ({
        att: image.att,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        bytes: image.bytes,
        status: image.status,
      })).filter(image => image.att)
    : undefined;
  const primary = metadata.images?.find(image => image.id === metadata.primaryImageId);
  return {
    type: node.type,
    position: node.position,
    width: node.width,
    height: node.height,
    ...(images?.length ? { images } : {}),
    ...(metadata.size ? { size: metadata.size } : {}),
    ...(metadata.quality ? { quality: metadata.quality } : {}),
    ...(primary?.att ? { primaryImageId: primary.att } : {}),
  };
}

function pageFromNode(node: CanvasNodeData) {
  const metadata = node.metadata || {};
  const references = Array.isArray(metadata.references)
    ? metadata.references.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    id: node.id,
    prompt: metadata.prompt || metadata.composerContent || (node.type === 'text' ? metadata.content : undefined),
    ref: references,
    model: storedModelName(metadata.model),
    tasks: metadata.taskId ? [metadata.taskId] : undefined,
    custom_field: {
      xaisCanvas: { version: XAIS_EMBED_VERSION, node: nodeForPageStorage(node) },
    },
  };
}

// 画布数据在 embed 模式下通过 postMessage 触发 flushXaisCanvasProject 保存到服务器。
// 本地只保留“当前文件”的快照草稿(按 fileId 分key,避免多个文件共用同一个 key 相互覆盖),
// zustand persist 写入被 patch 后的 use-canvas-store 改写为写入此 key(带 debounce)。
const CANVAS_STORE_KEY = 'infinite-canvas:canvas_store';

export const xaisCanvasStorageKey = () => `${CANVAS_STORE_KEY}:${xaisFileId()}`;

export async function flushXaisCanvasProject(): Promise<boolean> {
  // 直接读内存中的 zustand store(始终是最新状态),不依赖可能过期/串台的 localStorage 快照
  const snapshot = useCanvasStore.getState();
  // 当前 fileId 对应的项目(embed 模式恒为 projects[0],这里仍按 id 精确匹配兜底)
  const currentId = xaisFileId();
  const project = (currentId ? snapshot.projects.find(p => String(p.id) === currentId) : undefined) || snapshot.projects[0];
  if (!project) return false;
  const file = await getXaisFile();
  const previous = (file.assets?.xaisCanvas || {}) as XaisCanvasAssets;
  const assets: XaisCanvasAssets = {
    ...previous,
    version: XAIS_EMBED_VERSION,
    canvas: {
      ...previous.canvas,
      connections: project.connections,
      viewport: project.viewport,
      backgroundMode: project.backgroundMode,
      showImageInfo: project.showImageInfo,
      chatSessions: project.chatSessions,
      activeChatId: project.activeChatId,
    },
  };
    const pages = project.nodes.map(node => {
    const savedPage = file.pages?.find(page => page.id === node.id);
    const nextPage = pageFromNode(node);
    return savedPage?.tasks?.length && !nextPage.tasks?.length ? { ...nextPage, tasks: savedPage.tasks } : nextPage;
  });
  await updateXaisFile({ id: file.id, pages, assets: { ...(file.assets || {}), xaisCanvas: assets } });
  // 保存成功后清掉本地草稿(按 fileId 分 key),避免下次打开读到旧快照
  await localForageStorage.removeItem(xaisCanvasStorageKey());
  return true;
}

// 监听父页面的保存请求
if (typeof window !== 'undefined') {
  window.addEventListener('message', async event => {
    if (event.data?.type !== 'xais-save') return;
    try {
      const success = await flushXaisCanvasProject();
      (event.source as Window | null)?.postMessage({ type: 'xais-save-result', success }, event.origin);
    } catch (error) {
      (event.source as Window | null)?.postMessage({ type: 'xais-save-result', success: false, error: String(error) }, event.origin);
    }
  });

  // 容灾:抽屉关闭会销毁 iframe(pagehide)。此时把内存中的最新项目写成本地草稿,
  // 下次打开同 fileId 时优先恢复草稿,避免未点击“保存”就关闭导致的最近修改丢失。
  // 草稿是按 fileId 分 key 的,不会串台到其他文件。
  // 注意:本模块与 use-canvas-store.ts 存在循环依赖(use-canvas-store 导入本模块),
  // useCanvasStore 只能在事件回调里运行时访问,禁止在模块顶层调用其任何方法,否则 TDZ 报错。
  window.addEventListener('pagehide', () => {
    const snapshot = useCanvasStore.getState();
    const project = snapshot.projects[0];
    if (!project) return;
    const storageValue = { state: { projects: [project], deletedProjects: snapshot.deletedProjects }, version: 0 };
    void localForageStorage.setItem(xaisCanvasStorageKey(), JSON.stringify(storageValue));
  });
}
