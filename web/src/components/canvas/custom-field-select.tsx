import { useEffect, useState, type CSSProperties } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import type { AiConfig, ModelCustomSelectField } from "@/stores/use-config-store";

type CustomFieldSelectProps = {
    config: AiConfig;
    field: ModelCustomSelectField;
    nodeId: string;
    node?: CanvasNodeData;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    className?: string;
    style?: CSSProperties;
};

export function configValueForField(config: AiConfig, fieldName: string): string | undefined {
    if (fieldName === "ratio") return config.size;
    if (fieldName === "resolution") return config.vquality;
    if (fieldName === "seconds") return config.videoSeconds;
    if (fieldName === "quality") return config.quality;
    if (fieldName === "mode") return config.videoMode;
    if (fieldName === "generateAudio") return config.videoGenerateAudio;
    if (fieldName === "watermark") return config.videoWatermark;
    if (fieldName === "count") return String(config.count);
    return undefined;
}

export function customFieldToMetadata(fieldName: string, value: string): Partial<CanvasNodeMetadata> {
    if (fieldName === "ratio") return { size: value };
    if (fieldName === "resolution") return { vquality: value };
    if (fieldName === "seconds") return { seconds: value };
    if (fieldName === "quality") return { quality: value };
    if (fieldName === "mode") return { videoMode: value };
    if (fieldName === "generateAudio") return { generateAudio: value };
    if (fieldName === "watermark") return { watermark: value };
    if (fieldName === "count") return { count: Number(value) || 1 };
    return { [fieldName]: value } as Partial<CanvasNodeMetadata>;
}

export function CustomFieldSelect({ config, field, nodeId, node, onConfigChange, theme, className, style }: CustomFieldSelectProps) {
    const computed = (() => {
        const options = field.options.map((option) => String(option.value));
        const metadata = node?.metadata as Record<string, unknown> | undefined;
        const rawStored = node?.metadata?.xaisFields?.[field.fieldName] ?? metadata?.[field.fieldName];
        const stored = rawStored === undefined || rawStored === null ? "" : String(rawStored);
        if (stored && options.includes(stored)) return stored;
        const value = configValueForField(config, field.fieldName);
        return value !== undefined && options.includes(String(value)) ? String(value) : options[0];
    })();
    const [localValue, setLocalValue] = useState(computed);

    useEffect(() => {
        setLocalValue(computed);
    }, [computed]);

    return (
        <select
            className={className}
            style={{ ...style, color: theme.node.text, background: theme.node.fill, borderColor: theme.node.stroke }}
            value={localValue}
            onChange={(event) => {
                const value = event.target.value;
                setLocalValue(value);
                const patch = {
                    ...customFieldToMetadata(field.fieldName, value),
                    xaisFields: { ...node?.metadata?.xaisFields, [field.fieldName]: value },
                };
                requestAnimationFrame(() => requestAnimationFrame(() => onConfigChange(nodeId, patch)));
            }}
        >
            {field.options.map((option) => (
                <option key={String(option.value)} value={String(option.value)}>
                    {option.label || option.value}
                </option>
            ))}
        </select>
    );
}
