/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { useEffect, useRef, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.HtmlPreview as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    autoRender: {
        type: OptionType.BOOLEAN,
        description: "Render previews immediately instead of waiting for you to click Run",
        default: false,
    },
    allowRemoteResources: {
        type: OptionType.BOOLEAN,
        description: "Let previews load scripts, styles and images and make requests over https (needed for CDN libraries). This exposes your IP to whatever hosts the HTML contacts",
        default: false,
    },
    maxHeight: {
        type: OptionType.NUMBER,
        description: "Maximum preview height in pixels",
        default: 600,
    },
    maxFileSizeKb: {
        type: OptionType.NUMBER,
        description: "Largest HTML attachment to download for previewing, in KB",
        default: 2048,
    },
});

type PreviewSource =
    | { kind: "code"; html: string; label: string; }
    | { kind: "attachment"; url: string; label: string; };

const HTML_CODE_BLOCK = /```html\n([\s\S]*?)```/gi;

function getSources(message: Message): PreviewSource[] {
    const sources: PreviewSource[] = [];

    for (const attachment of message.attachments ?? []) {
        if (/\.html?$/i.test(attachment.filename) || attachment.content_type?.startsWith("text/html"))
            sources.push({ kind: "attachment", url: attachment.url, label: attachment.filename });
    }

    for (const [, html] of message.content?.matchAll(HTML_CODE_BLOCK) ?? []) {
        if (html.trim()) sources.push({ kind: "code", html, label: "HTML code block" });
    }

    return sources;
}

function HtmlPreview({ source }: { source: PreviewSource; }) {
    const { autoRender, allowRemoteResources, maxHeight, maxFileSizeKb } = settings.use(["autoRender", "allowRemoteResources", "maxHeight", "maxFileSizeKb"]);

    const [running, setRunning] = useState(autoRender);
    const [src, setSrc] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [height, setHeight] = useState(150);
    const frameRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        if (!running) return;

        let cancelled = false;
        const request = source.kind === "code"
            ? Native.registerHtml(source.html, allowRemoteResources)
            : Native.registerAttachment(source.url, allowRemoteResources, maxFileSizeKb * 1024);

        request.then(
            url => !cancelled && setSrc(url),
            err => !cancelled && setError(String(err?.message ?? err))
        );

        return () => { cancelled = true; };
    }, [running, allowRemoteResources]);

    useEffect(() => {
        if (!src) return;

        const onMessage = (e: MessageEvent) => {
            if (e.source !== frameRef.current?.contentWindow) return;

            const reported = e.data?.__vcHtmlPreviewHeight;
            if (typeof reported === "number" && Number.isFinite(reported))
                setHeight(Math.min(Math.max(reported, 40), maxHeight));
        };

        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [src, maxHeight]);

    const toggle = () => {
        setRunning(!running);
        setSrc(null);
        setError(null);
    };

    return (
        <div className="vc-html-preview">
            <div className="vc-html-preview-header">
                <span className="vc-html-preview-label">{source.label}</span>
                <span className="vc-html-preview-badge">
                    {allowRemoteResources ? "sandboxed · network on" : "sandboxed · offline"}
                </span>
                <Button size="small" variant={running ? "secondary" : "primary"} onClick={toggle}>
                    {running ? "Stop" : "Run"}
                </Button>
            </div>
            {error && <div className="vc-html-preview-error">{error}</div>}
            {running && src && (
                <iframe
                    ref={frameRef}
                    className="vc-html-preview-frame"
                    title={source.label}
                    src={src}
                    sandbox="allow-scripts"
                    allow=""
                    referrerPolicy="no-referrer"
                    style={{ height }}
                />
            )}
        </div>
    );
}

export default definePlugin({
    name: "HtmlPreview",
    description: "Renders .html attachments and ```html code blocks in chat, inside a sandboxed iframe that is offline by default",
    authors: [{ name: "hezaerd", id: 0n }],
    settings,

    renderMessageAccessory({ message }) {
        const sources = getSources(message);
        if (!sources.length) return null;

        return sources.map((source, i) => <HtmlPreview key={`${message.id}-${i}`} source={source} />);
    },
});
