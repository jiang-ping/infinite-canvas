export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    /** Xais embed:参考图对应的 OSS 附件名,worker 脚本可直接复用,无需重新上传 */
    att?: string;
};
