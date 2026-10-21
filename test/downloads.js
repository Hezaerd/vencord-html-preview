/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const assert = require("node:assert/strict");

module.exports = async function testDownloads(native) {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const url = "https://cdn.discordapp.com/attachments/test.html";
    let signal;
    let reads;

    const respond = (chunks, headers = {}) => {
        reads = 0;
        globalThis.fetch = async (_, options) => {
            signal = options.signal;
            assert.equal(options.redirect, "error");
            return new Response(new ReadableStream({
                pull(controller) {
                    if (reads < chunks.length) controller.enqueue(chunks[reads++]);
                    else controller.close();
                }
            }, { highWaterMark: 0 }), { headers });
        };
    };

    try {
        const bytes = new TextEncoder().encode("<p>é</p>");
        respond([bytes.slice(0, 4), bytes.slice(4)]);
        const preview = await native.registerAttachment(null, url, false, bytes.length);
        assert.match(preview, /^vc-html-preview:\/\/doc\//);
        const html = await (await require("electron").net.fetch(preview)).text();
        assert.ok(html.includes("<p>é</p>"), "UTF-8 survives a split multibyte character");
        console.log("PASS  attachment at the exact byte limit preserves streamed UTF-8");

        for (const headers of [{}, { "content-length": "1" }]) {
            respond([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)], headers);
            await assert.rejects(native.registerAttachment(null, url, false, 5), /larger than/);
            assert.equal(reads, 2, "stop reading at the first chunk over the limit");
            assert.ok(signal.aborted, "abort the download after overflow");
        }
        console.log("PASS  missing and understated content lengths cannot bypass the streaming limit");

        respond([bytes], { "content-length": "100" });
        await assert.rejects(native.registerAttachment(null, url, false, 5), /larger than/);
        assert.equal(reads, 0);
        assert.ok(signal.aborted);
        console.log("PASS  oversized content length is rejected before reading the body");

        respond([bytes], { "content-length": String(10 * 1024 * 1024 + 1) });
        await assert.rejects(native.registerAttachment(null, url, false, 20 * 1024 * 1024), /larger than/);
        for (const limit of [0, -1, NaN, Infinity])
            await assert.rejects(native.registerAttachment(null, url, false, limit), /positive finite/);
        await assert.rejects(native.registerAttachment(null, "https://example.com/test.html", false, 100), /Only Discord/);
        console.log("PASS  hard size cap, invalid limits and attachment host restrictions are enforced");

        globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 15_000 ? 20 : delay, ...args);
        for (const stallBody of [false, true]) {
            globalThis.fetch = async (_, options) => {
                signal = options.signal;
                if (!stallBody) return new Promise((_, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
                return new Response(new ReadableStream({
                    start(controller) {
                        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
                    }
                }));
            };
            await assert.rejects(native.registerAttachment(null, url, false, 100), /timed out/);
            assert.ok(signal.aborted);
        }
        console.log("PASS  timeout aborts both stalled response headers and stalled bodies");
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
    }
};
