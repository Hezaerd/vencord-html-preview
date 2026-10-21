/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const paths = process.env.PATH.split(delimiter).map(path => resolve(path, ".."));
const React = require(require.resolve("react", { paths }));
const { act, create } = require(require.resolve("react-test-renderer", { paths }));
const settings = { autoRender: true, allowRemoteResources: false, maxHeight: 600, maxFileSizeKb: 2048 };
const requests = [];
const native = {};
for (const method of ["registerHtml", "registerAttachment"]) {
    native[method] = (...args) => new Promise((resolve, reject) => requests.push({ method, args, resolve, reject }));
}

const boundary = ({ children }) => children;
const modules = {
    "@api/Settings": { definePluginSettings: () => ({ use: () => settings, store: settings }) },
    "@components/Button": { Button: "button" },
    "@components/ErrorBoundary": boundary,
    "@utils/misc": { classes: (...values) => values.filter(Boolean).join(" ") },
    "@utils/react": { useForceUpdater: () => React.useReducer(n => n + 1, 0)[1] },
    "@utils/types": { __esModule: true, default: plugin => plugin, OptionType: {} },
    "@webpack": { findCssClassesLazy: () => ({}) },
    "@webpack/common": { ...React, Clickable: "button", Tooltip: "span" },
    react: React
};
const module = { exports: {} };
runInNewContext(readFileSync(process.env.HTML_PREVIEW_RENDERER, "utf8"), {
    module,
    exports: module.exports,
    require: name => {
        assert.ok(name in modules, `Unexpected import: ${name}`);
        return modules[name];
    },
    VencordNative: { pluginHelpers: { HtmlPreview: native } },
    React,
    window: { addEventListener() {}, removeEventListener() {} }
});
const plugin = module.exports.default;
const code = html => plugin.renderMessageAccessory({ message: { id: "1", content: "```html\n" + html + "```" } });
const attachment = url => plugin.renderCodeOrHtml({ url, fileName: "test.html", expanded: true }, "html", null);
let root;
await act(async () => { root = create(code("old")); });
assert.equal(requests.length, 1);
await act(async () => { root.update(code("edited")); });
assert.equal(requests.length, 2);
assert.equal(requests[1].args[0], "edited");
await act(async () => { requests[1].resolve("vc-html-preview://doc/edited"); });
await act(async () => { requests[0].resolve("vc-html-preview://doc/old"); });
assert.equal(root.root.findByType("iframe").props.src, "vc-html-preview://doc/edited");
await act(async () => { root.update(code("edited")); });
assert.equal(requests.length, 2, "fresh source objects must not restart unchanged previews");
console.log("PASS  edits refresh previews and late results cannot replace newer content");

await act(async () => { root.update(attachment("https://cdn.discordapp.com/first.html")); });
let request = requests.at(-1);
assert.equal(request.method, "registerAttachment");
await act(async () => { request.resolve("vc-html-preview://doc/first"); });
await act(async () => { root.update(attachment("https://cdn.discordapp.com/second.html")); });
request = requests.at(-1);
assert.equal(request.args[0], "https://cdn.discordapp.com/second.html");
assert.equal(root.toJSON(), null, "old preview is cleared while the new URL loads");
await act(async () => { request.reject(new Error("Too large")); });
assert.ok(JSON.stringify(root.toJSON()).includes("Too large"));

settings.maxFileSizeKb = 4096;
await act(async () => { root.update(attachment("https://cdn.discordapp.com/second.html")); });
request = requests.at(-1);
assert.equal(request.args[2], 4096 * 1024);
assert.equal(root.toJSON(), null, "retry clears the previous error");
settings.allowRemoteResources = true;
await act(async () => { root.update(attachment("https://cdn.discordapp.com/second.html")); });
assert.equal(requests.at(-1).args[1], true);
await act(async () => { requests.at(-1).resolve("vc-html-preview://doc/online"); });
await act(async () => { request.reject(new Error("Obsolete failure")); });
assert.equal(root.root.findByType("iframe").props.src, "vc-html-preview://doc/online");
await act(async () => { root.unmount(); });
console.log("PASS  URL and setting changes reload attachments and ignore obsolete errors");
