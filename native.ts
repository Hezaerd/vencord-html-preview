/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CspPolicies } from "@main/csp";
import { randomUUID } from "crypto";
import { app, IpcMainInvokeEvent, protocol } from "electron";

// Previews are served from their own scheme instead of srcdoc/blob:
// - srcdoc and blob: documents inherit Discord's CSP, whose script-src nonce blocks every inline script
// - a separate scheme gives the frame an opaque origin with its own CSP, without opening a network port
const SCHEME = "vc-html-preview";

const MAX_DOCUMENTS = 64;
const HARD_SIZE_LIMIT = 10 * 1024 * 1024;
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

// Lets Discord's page embed our scheme in an iframe. Navigating the frame anywhere else stays blocked by Discord's frame-src
CspPolicies[`${SCHEME}:`] = ["frame-src"];

const OFFLINE_POLICY = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "worker-src blob:",
];

const ONLINE_POLICY = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob: https:",
    "style-src 'unsafe-inline' https:",
    "img-src data: blob: https:",
    "font-src data: https:",
    "media-src data: blob: https:",
    "connect-src https:",
    "worker-src blob:",
];

const COMMON_POLICY = [
    "form-action 'none'",
    "base-uri 'none'",
    // Same flags as the iframe's sandbox attribute, so the document stays sandboxed even if loaded some other way
    "sandbox allow-scripts",
];

// Reports the content height so the iframe can grow with it. The parent only accepts a clamped number from this frame
const HEIGHT_REPORTER = "<script>(()=>{const p=()=>parent.postMessage({__vcHtmlPreviewHeight:Math.ceil(document.documentElement.scrollHeight)},\"*\");addEventListener(\"load\",p);new ResizeObserver(p).observe(document.documentElement)})()</script>";

interface PreviewDocument {
    html: string;
    allowRemote: boolean;
}

const documents = new Map<string, PreviewDocument>();

function injectHeightReporter(html: string) {
    // Keep the doctype first, otherwise the page would render in quirks mode
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    if (!doctype) return HEIGHT_REPORTER + html;
    return doctype[0] + HEIGHT_REPORTER + html.slice(doctype[0].length);
}

function storeDocument(html: string, allowRemote: boolean) {
    const id = randomUUID();
    documents.set(id, { html: injectHeightReporter(html), allowRemote });

    while (documents.size > MAX_DOCUMENTS)
        documents.delete(documents.keys().next().value!);

    return `${SCHEME}://doc/${id}`;
}

app.whenReady().then(() => {
    protocol.handle(SCHEME, req => {
        const id = new URL(req.url).pathname.slice(1);
        const doc = documents.get(id);

        if (!doc)
            return new Response("This preview has expired. Click Run again.", {
                status: 404,
                headers: { "Content-Type": "text/plain; charset=utf-8" }
            });

        const policy = [...(doc.allowRemote ? ONLINE_POLICY : OFFLINE_POLICY), ...COMMON_POLICY].join("; ");

        return new Response(doc.html, {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": policy,
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "no-store",
            }
        });
    });
});

export function registerHtml(_: IpcMainInvokeEvent, html: string, allowRemote: boolean) {
    if (typeof html !== "string") throw new Error("Expected an HTML string");
    if (html.length > HARD_SIZE_LIMIT) throw new Error("HTML is too large to preview");

    return storeDocument(html, allowRemote === true);
}

export async function registerAttachment(_: IpcMainInvokeEvent, url: string, allowRemote: boolean, maxBytes: number) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ATTACHMENT_HOSTS.has(parsed.hostname))
        throw new Error("Only Discord attachment URLs can be previewed");

    const limit = Math.min(Number(maxBytes) || 0, HARD_SIZE_LIMIT);

    const res = await fetch(parsed, { redirect: "error" });
    if (!res.ok) throw new Error(`Failed to download attachment (HTTP ${res.status})`);

    const declaredLength = Number(res.headers.get("content-length"));
    if (declaredLength > limit) throw new Error("Attachment is larger than the preview size limit");

    const body = await res.arrayBuffer();
    if (body.byteLength > limit) throw new Error("Attachment is larger than the preview size limit");

    return storeDocument(new TextDecoder().decode(body), allowRemote === true);
}
