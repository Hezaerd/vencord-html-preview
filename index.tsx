/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findCssClassesLazy } from "@webpack";
import { Clickable, Tooltip, useEffect, useRef, useState } from "@webpack/common";
import { ReactNode } from "react";

const Native = VencordNative.pluginHelpers.HtmlPreview as PluginNative<typeof import("./native")>;

// Discord's plaintext attachment preview, so the toggle looks like the buttons next to it
const PreviewClasses = findCssClassesLazy("languageIcon", "openFullPreviewSection");

const settings = definePluginSettings({
    autoRender: {
        type: OptionType.BOOLEAN,
        description: "Show HTML attachments and code blocks rendered by default instead of as code",
        default: false,
    },
    allowRemoteResources: {
        type: OptionType.BOOLEAN,
        description: "Let previews load scripts, styles and images and make requests over https (needed for CDN libraries). This exposes your IP to whatever hosts the HTML contacts",
        default: false,
    },
    maxHeight: {
        type: OptionType.NUMBER,
        description: "Maximum inline preview height in pixels",
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

// Props of Discord's inline preview and of its fullscreen modal (the modal has transitionState instead of setExpanded)
interface PlaintextPreviewProps {
    url: string;
    fileName: string;
    expanded?: boolean;
    setExpanded?(expanded: boolean): void;
    transitionState?: unknown;
}

const HTML_LANGUAGES = new Set(["html", "htm", "xhtml"]);
const HTML_CODE_BLOCK = /```html\n([\s\S]*?)```/gi;

const isHtmlLanguage = (language: unknown) => typeof language === "string" && HTML_LANGUAGES.has(language.toLowerCase());

// Rendered/code mode per attachment URL, shared by the inline preview and its fullscreen modal
const renderModes = new Map<string, boolean>();
const renderModeListeners = new Set<() => void>();

const isRendering = (url: string) => renderModes.get(url) ?? settings.store.autoRender;

function setRendering(url: string, rendering: boolean) {
    renderModes.set(url, rendering);
    renderModeListeners.forEach(listener => listener());
}

function useRendering(url: string) {
    const forceUpdate = useForceUpdater();

    useEffect(() => {
        renderModeListeners.add(forceUpdate);
        return () => void renderModeListeners.delete(forceUpdate);
    }, []);

    return isRendering(url);
}

function HtmlFrame({ source, fill }: { source: PreviewSource; fill?: boolean; }) {
    const { allowRemoteResources, maxHeight, maxFileSizeKb } = settings.use(["allowRemoteResources", "maxHeight", "maxFileSizeKb"]);

    const [src, setSrc] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [height, setHeight] = useState(150);
    const frameRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        let cancelled = false;
        setSrc(null);
        setError(null);

        const request = source.kind === "code"
            ? Native.registerHtml(source.html, allowRemoteResources)
            : Native.registerAttachment(source.url, allowRemoteResources, maxFileSizeKb * 1024);

        request.then(
            url => !cancelled && setSrc(url),
            err => !cancelled && setError(String(err?.message ?? err))
        );

        return () => { cancelled = true; };
    }, [allowRemoteResources]);

    useEffect(() => {
        if (!src || fill) return;

        const onMessage = (e: MessageEvent) => {
            if (e.source !== frameRef.current?.contentWindow) return;

            const reported = e.data?.__vcHtmlPreviewHeight;
            if (typeof reported === "number" && Number.isFinite(reported))
                setHeight(Math.min(Math.max(reported, 40), maxHeight));
        };

        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [src, fill, maxHeight]);

    if (error) return <div className="vc-html-preview-error">{error}</div>;
    if (!src) return null;

    return (
        <iframe
            ref={frameRef}
            className={classes("vc-html-preview-frame", fill && "vc-html-preview-frame-fill")}
            title={source.label}
            src={src}
            sandbox="allow-scripts"
            allow=""
            referrerPolicy="no-referrer"
            style={fill ? undefined : { height }}
        />
    );
}

function EyeIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5ZM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
        </svg>
    );
}

function LinesIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4 5h16v2H4V5Zm0 4h16v2H4V9Zm0 4h16v2H4v-2Zm0 4h10v2H4v-2Z" />
        </svg>
    );
}

function RenderToggle({ preview }: { preview: PlaintextPreviewProps; }) {
    const rendering = useRendering(preview.url);
    const label = rendering ? "Show code" : "Render HTML (sandboxed)";

    const toggle = () => {
        setRendering(preview.url, !rendering);
        // A collapsed inline preview is only a few lines tall, too small for a page
        if (!rendering) preview.setExpanded?.(true);
    };

    return (
        <Tooltip text={label}>
            {tooltipProps => (
                <Clickable
                    {...tooltipProps}
                    className={classes(PreviewClasses.languageIcon, "vc-html-preview-toggle")}
                    aria-label={label}
                    aria-pressed={rendering}
                    onClick={toggle}
                >
                    {rendering ? <LinesIcon /> : <EyeIcon />}
                </Clickable>
            )}
        </Tooltip>
    );
}

function CodeOrHtml({ preview, code }: { preview: PlaintextPreviewProps; code: ReactNode; }) {
    const rendering = useRendering(preview.url);
    const isModal = preview.transitionState != null;

    useEffect(() => {
        if (rendering && !isModal && !preview.expanded) preview.setExpanded?.(true);
    }, []);

    if (!rendering) return code;

    return (
        <HtmlFrame
            source={{ kind: "attachment", url: preview.url, label: preview.fileName }}
            fill={isModal}
        />
    );
}

function CodeBlockPreview({ html }: { html: string; }) {
    const { autoRender, allowRemoteResources } = settings.use(["autoRender", "allowRemoteResources"]);
    const [running, setRunning] = useState(autoRender);

    return (
        <div className="vc-html-preview">
            <div className="vc-html-preview-header">
                <span className="vc-html-preview-label">HTML code block</span>
                <span className="vc-html-preview-badge">
                    {allowRemoteResources ? "sandboxed · network on" : "sandboxed · offline"}
                </span>
                <Button size="small" variant={running ? "secondary" : "primary"} onClick={() => setRunning(!running)}>
                    {running ? "Stop" : "Run"}
                </Button>
            </div>
            {running && <HtmlFrame source={{ kind: "code", html, label: "HTML code block" }} />}
        </div>
    );
}

export default definePlugin({
    name: "HtmlPreview",
    description: "Adds a toggle to Discord's preview of .html attachments that renders them in a sandboxed, offline iframe. Also previews ```html code blocks",
    authors: [{ name: "hezaerd", id: 0n }],
    settings,

    patches: [
        {
            // Discord's plaintext attachment preview, inline and in the fullscreen modal
            find: '"PlaintextFileMarkdownPreview"',
            replacement: [
                {
                    // The code view: swap in the rendered page when the toggle is on
                    match: /\(0,\i\.jsx\)\(\i,\{text:\i\+\i,language:(\i),wordWrap:\i\}\)/g,
                    replace: "$self.renderCodeOrHtml(arguments[0],$1,$&)"
                },
                {
                    // The language picker button: put the toggle right before it
                    match: /\(0,\i\.jsx\)\(\i,\{language:(\i),setLanguage:\i,align:"(?:top|bottom)"\}\)/g,
                    replace: "$self.renderToggle(arguments[0],$1),$&"
                }
            ]
        }
    ],

    renderCodeOrHtml(preview: PlaintextPreviewProps, language: string, code: ReactNode) {
        if (!isHtmlLanguage(language)) return code;

        return (
            <ErrorBoundary fallback={() => code}>
                <CodeOrHtml preview={preview} code={code} />
            </ErrorBoundary>
        );
    },

    renderToggle(preview: PlaintextPreviewProps, language: string) {
        if (!isHtmlLanguage(language)) return null;

        return (
            <ErrorBoundary noop>
                <RenderToggle preview={preview} />
            </ErrorBoundary>
        );
    },

    renderMessageAccessory({ message }) {
        const blocks = [...message.content?.matchAll(HTML_CODE_BLOCK) ?? []]
            .map(([, html]) => html)
            .filter(html => html.trim());

        return blocks.map((html, i) => <CodeBlockPreview key={`${message.id}-${i}`} html={html} />);
    },
});
