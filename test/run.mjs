/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Bundles native.ts into a temp dir and runs the Electron test against it.
// Nothing is written inside the plugin folder, so Vencord's tsc and eslint stay clean
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), "vc-html-preview-test-"));
const bundle = join(outDir, "native.js");

const run = (cmd, args, env) => spawnSync(cmd, args, { stdio: "inherit", shell: true, env: { ...process.env, ...env } }).status;

try {
    const built = run("esbuild", [
        JSON.stringify(join(here, "..", "native.ts")),
        "--bundle", "--platform=node", "--format=cjs", "--external:electron", "--log-level=warning",
        `--alias:@main/csp=${JSON.stringify(join(here, "csp-stub.js"))}`,
        `--outfile=${JSON.stringify(bundle)}`,
    ]);
    if (built !== 0) process.exit(built ?? 1);

    // Electron would run as plain Node if this is inherited from an Electron-based terminal
    delete process.env.ELECTRON_RUN_AS_NODE;
    process.exitCode = run("electron", [JSON.stringify(join(here, "main.js"))], { HTML_PREVIEW_NATIVE: bundle }) ?? 1;
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
