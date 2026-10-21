# HtmlPreview

A [Vencord](https://github.com/Vendicated/Vencord) plugin that renders `.html` attachments and ` ```html ` code blocks inside Discord, so you don't have to download the file and open it in a browser.

Previews run in a sandboxed iframe that can't reach your Discord session, and they're offline by default.

## Install

This is a user plugin, so you need a Vencord build from source ([Vencord's guide](https://docs.vencord.dev/installing/custom-plugins/)).

```sh
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install
git clone https://github.com/hezaerd/vencord-html-preview src/userplugins/htmlPreview.desktop
pnpm build
pnpm inject
```

Keep the folder name `htmlPreview.desktop`. The `.desktop` suffix tells Vencord the plugin needs the desktop app, because it has a native (main process) part.

Fully quit and restart Discord, then enable **HtmlPreview** in Vencord's plugin settings. Reloading with Ctrl+R isn't enough the first time, since the plugin registers its URL scheme and CSP rule at startup.

Works on Discord desktop and Vesktop, not on the browser extension or userscript.

## Usage

`.html` attachments: Discord already previews these as code. The plugin adds an eye button to that preview's toolbar, next to the `<>` language picker. Click it to render the page in place of the code, and click again to go back to the code. It works in the fullscreen view too, and the fullscreen view opens in whichever mode the inline preview is in. The button only shows while the preview's language is HTML.

` ```html ` code blocks: these get a preview card below the message. Click **Run** to render the block and **Stop** to unload it.

| Setting | Default | |
|---|---|---|
| Auto render | off | Show HTML rendered by default instead of as code |
| Allow remote resources | off | Let previews load scripts, styles and images and make requests over https, which CDN libraries like Chart.js or Tailwind need. Hosts the HTML contacts will see your IP |
| Max height | 600 | Height cap for inline previews in pixels. Previews grow to fit their content up to this height |
| Max file size | 2048 KB | Largest attachment that gets downloaded for previewing |

## How it stays isolated

Embedding the HTML with `<iframe srcdoc>` doesn't work. Srcdoc and `blob:` documents inherit Discord's Content-Security-Policy, and its `script-src` nonce blocks every inline script.

The plugin's native part serves each preview from its own scheme, `vc-html-preview://doc/<random id>`, through Electron's `protocol.handle`. No network port is opened. It adds `vc-html-preview:` to Discord's `frame-src` through Vencord's `CspPolicies`, and each preview is served with its own policy:

```
sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:;
style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:;
worker-src blob:; form-action 'none'; base-uri 'none'
```

The iframe also has `sandbox="allow-scripts"`. As a result:

- The preview has an opaque (`null`) origin, so it can't read Discord's DOM, localStorage, cookies or token.
- There's no Node.js and no `DiscordNative`.
- Offline previews can't make any network request. Forms, popups and top-level navigation are blocked.
- Discord's own `frame-src` blocks the preview from navigating itself to another site.
- Previews run in a different process from Discord, so an infinite loop in one doesn't freeze the client.
- Attachments are downloaded by the main process, only from `cdn.discordapp.com` and `media.discordapp.net`, without following redirects, and only up to the size limit.
- Downloads stop as soon as the streamed response exceeds the size limit, even without an accurate content length, and time out after 15 seconds.

The one message a preview can send to Discord is its height, which is accepted only from that iframe and clamped.

## Limits

- A preview can draw anything, including a fake login screen. In offline mode, anything typed into it has nowhere to go. With remote resources on, it could be sent out.
- All previews share one process, so a preview stuck in a loop freezes the other previews (not Discord). Switch it back to code.
- A preview can still navigate itself to hosts on Discord's own `frame-src` allowlist, such as YouTube embeds or `https://localhost`. That request reveals your IP but carries no Discord session.
- Code block previews appear below the message instead of replacing the code block.
- The attachment toggle patches Discord's preview code. A Discord update can break the patch; Vencord then logs a warning and the plain code preview keeps working.
- Using any client mod is against Discord's Terms of Service.

## Security test

`test/` checks preview refreshes with React's test renderer and download limits with streamed responses, then runs an Electron sandbox test. It loads a fake discord.com page with Discord's live CSP (patched the same way Vencord patches it), embeds previews served by the plugin's real `native.ts`, and runs hostile HTML that tries to break out. It needs Node.js 20+ and downloads Electron, esbuild, React and its test renderer through `npx`.

```sh
cd test
npm test
```

It prints a PASS/FAIL line for each check and exits non-zero on any failure. Nothing gets written to the plugin folder, so it can be run from inside a Vencord checkout.

## License

GPL-3.0-or-later, the same as Vencord.
