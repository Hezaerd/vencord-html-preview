/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Security test: a fake discord.com page using Discord's live CSP (patched the way Vencord patches it)
// embeds previews served by the plugin's native.ts, while hostile HTML inside them tries to break out.
const { app, BrowserWindow, protocol } = require("electron");

const native = require(process.env.HTML_PREVIEW_NATIVE);
const CspPolicies = globalThis.__CspPolicies;

const requests = [];
const popups = [];
const failures = [];

const esc = value => JSON.stringify(value).split("<").join("\\u003c");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function check(name, ok, detail) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(detail)})`}`);
    if (!ok) failures.push(name);
}

// Mirrors patchCsp in Vencord's src/main/csp/index.ts
function vencordPatchCsp(raw) {
    const csp = {};
    for (const directive of raw.split(";")) {
        const [key, ...values] = directive.trim().split(/\s+/g);
        if (key && !(key in csp)) csp[key] = values;
    }

    const push = (directive, ...values) => {
        csp[directive] ??= [...(csp["default-src"] ?? [])];
        csp[directive].push(...values);
    };

    push("style-src", "'unsafe-inline'");
    push("script-src", "'unsafe-inline'", "'unsafe-eval'");
    for (const directive of ["style-src", "connect-src", "img-src", "font-src", "media-src", "worker-src"])
        push(directive, "blob:", "data:", "vencord:", "vesktop:");
    for (const [host, directives] of Object.entries(CspPolicies))
        for (const directive of directives) push(directive, host);

    delete csp["report-uri"];
    delete csp["report-to"];

    return Object.entries(csp).filter(([, v]) => v.length).map(e => e.flat().join(" ")).join("; ");
}

const probe = host => `<!doctype html><html><body><h1>probe</h1>
<img src="https://${host}/markup-img.png">
<script>
const r = {};
const t = (k, f) => { try { r[k] = String(f()); } catch (e) { r[k] = "BLOCKED"; } };
t("parent.document", () => parent.document.title);
t("top.SECRET", () => top.SECRET);
t("parent.localStorage", () => parent.localStorage.getItem("token"));
t("localStorage", () => localStorage.length);
t("document.cookie", () => document.cookie);
t("self.origin", () => self.origin);
t("window.open", () => window.open("https://${host}/popup"));
t("require", () => typeof require);
t("process", () => typeof process);
t("DiscordNative", () => typeof DiscordNative);
t("eval", () => eval("1+1"));
const done = () => { parent.postMessage({ probe: r }, "*"); try { top.location = "https://${host}/top-nav"; } catch (e) {} };
fetch("https://${host}/fetch").then(x => r.fetch = "OK " + x.status, () => r.fetch = "BLOCKED").finally(() => {
    const img = new Image();
    img.onload = () => { r.image = "LOADED"; done(); };
    img.onerror = () => { r.image = "ERROR"; done(); };
    img.src = "https://${host}/img.png";
});
</script>
<form id="f" action="https://${host}/form" method="post"><input name="a" value="1"></form>
<script>setTimeout(() => { try { f.submit(); } catch (e) {} }, 300);</script>
</body></html>`;

const SELF_NAV = "<!doctype html><script>setTimeout(() => location.href = \"https://nav.test/self-nav\", 200)</script>";
const META_REFRESH = "<!doctype html><meta http-equiv=\"refresh\" content=\"0;url=https://nav.test/meta-refresh\">";
const WIDE = "<!doctype html><body style=\"margin:0\"><div style=\"width:900px\">wide</div></body>";
const LOOP = "<!doctype html><script>parent.postMessage({ loop: \"start\" }, \"*\"); setTimeout(() => { for (;;) {} }, 50)</script>";

app.whenReady().then(async () => {
    const res = await fetch("https://discord.com/app", { method: "HEAD" });
    const rawCsp = res.headers.get("content-security-policy");
    if (!rawCsp) throw new Error("discord.com did not return a CSP header");
    const nonce = /'nonce-([^']+)'/.exec(rawCsp)?.[1] ?? "";
    const patchedCsp = vencordPatchCsp(rawCsp);

    const urls = {
        offline: native.registerHtml(null, probe("offline.test"), false),
        online: native.registerHtml(null, probe("online.test"), true),
        selfNav: native.registerHtml(null, SELF_NAV, false),
        metaRefresh: native.registerHtml(null, META_REFRESH, false),
        wide: native.registerHtml(null, WIDE, false),
        loop: native.registerHtml(null, LOOP, false),
    };

    const parentPage = `<!doctype html><title>Discord</title><body>
<script nonce="${nonce}">
window.SECRET = "discord-token";
localStorage.setItem("token", "discord-token");
window.results = { probes: {}, sizes: {}, loopTicks: null };
const frames = {};
window.addFrame = (name, attrs) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
    frames[name] = f;
    document.body.append(f);
};
addEventListener("message", e => {
    const name = Object.keys(frames).find(n => frames[n].contentWindow === e.source);
    if (e.data?.probe) results.probes[name] = e.data.probe;
    if (e.data?.__vcHtmlPreviewSize) results.sizes[name] = e.data.__vcHtmlPreviewSize;
    if (e.data?.loop === "start") {
        let ticks = 0;
        const iv = setInterval(() => ticks++, 10);
        setTimeout(() => { clearInterval(iv); results.loopTicks = ticks; }, 1500);
    }
});
addFrame("offline", { src: ${esc(urls.offline)} });
addFrame("online", { src: ${esc(urls.online)} });
addFrame("srcdoc", { srcdoc: ${esc(probe("srcdoc.test"))} });
addFrame("selfNav", { src: ${esc(urls.selfNav)} });
addFrame("metaRefresh", { src: ${esc(urls.metaRefresh)} });
addFrame("wide", { src: ${esc(urls.wide)} });
</script></body>`;

    protocol.handle("https", req => {
        if (new URL(req.url).hostname === "discord.test")
            return new Response(parentPage, { headers: { "Content-Type": "text/html", "Content-Security-Policy": patchedCsp } });

        requests.push(req.url);
        return new Response("ok", { headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" } });
    });

    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    win.webContents.setWindowOpenHandler(({ url }) => { popups.push(url); return { action: "deny" }; });

    await win.loadURL("https://discord.test/");
    await sleep(3000);

    const { probes, sizes } = await win.webContents.executeJavaScript("results");
    const offline = probes.offline ?? {};

    check("Discord's CSP lets the page frame previews", "offline" in probes, probes);
    for (const key of ["parent.document", "top.SECRET", "parent.localStorage", "localStorage", "document.cookie"])
        check(`preview cannot access ${key}`, offline[key] === "BLOCKED", offline[key]);
    check("preview has an opaque origin", offline["self.origin"] === "null", offline["self.origin"]);
    for (const key of ["require", "process", "DiscordNative"])
        check(`preview has no ${key}`, offline[key] === "undefined", offline[key]);
    check("inline scripts and eval run", offline.eval === "2", offline.eval);
    check("offline preview fetch is blocked", offline.fetch === "BLOCKED", offline.fetch);
    check("offline preview makes no network requests", !requests.some(u => u.includes("offline.test")), requests);
    check("network-on preview can fetch", probes.online?.fetch === "OK 200", probes.online?.fetch);
    check("popups are blocked", popups.length === 0, popups);
    check("forms and top navigation are blocked", win.webContents.getURL() === "https://discord.test/" && !requests.some(u => /\/(form|top-nav)$/.test(u)), requests);
    check("previews cannot navigate themselves away", !requests.some(u => u.includes("nav.test")), requests);
    check("preview reports its height", sizes.offline?.height > 0, sizes.offline);
    check("preview reports sideways overflow so the iframe can widen", sizes.wide?.scrollWidth >= 900 && sizes.wide.scrollWidth > sizes.wide.clientWidth, sizes.wide);
    check("naive srcdoc frame cannot run scripts (why the plugin uses its own scheme)", !("srcdoc" in probes), probes.srcdoc);

    // Last, because it freezes the process shared by all previews. A frozen parent would get ~0 ticks; Windows timer granularity caps a healthy one around 95-150
    await win.webContents.executeJavaScript(`addFrame("loop", { src: ${esc(urls.loop)} })`);
    await sleep(2500);
    const loopTicks = await win.webContents.executeJavaScript("results.loopTicks");
    check("an infinite loop in a preview does not freeze Discord", loopTicks > 20, loopTicks);

    const previewPids = win.webContents.mainFrame.frames.filter(f => f.url.startsWith("vc-html-preview:")).map(f => f.processId);
    check("previews run outside Discord's renderer process", previewPids.length > 0 && !previewPids.includes(win.webContents.mainFrame.processId), previewPids);

    console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll checks passed");
    app.exit(failures.length ? 1 : 0);
}).catch(err => {
    console.error(err);
    app.exit(1);
});
