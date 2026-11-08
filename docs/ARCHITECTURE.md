# Gentle Shell Browser architecture

How Gentle Shell Browser works inside: its two parts, how they find and trust each other, the native messaging helper on each platform, self-update, the policy rules and the safety model. For installing and using it, see the [README](../README.md) and the [user guide](GUIDE.md).

## The two parts

- **Pi package** (`src/`): loaded by Gentle Shell. Adds the `browser_*` tools and the `/browser` command. Each session serves an authenticated WebSocket on its own `127.0.0.1` port and registers itself locally.
- **Chrome extension** (`extension/`): "Gentle Shell Browser", loaded unpacked in Chrome. A small helper (a Chrome native messaging host) tells it the secret token and the live sessions; it connects to every one, enforces each session's tab group and the permission mode, and drives tabs through `chrome.debugger`, so pages receive real input events.

## How it works

Gentle Shell and Chrome run on the same machine (Linux, macOS or Windows), or Gentle Shell runs in WSL2 and Chrome on Windows. Either way they talk over `127.0.0.1` only.

```
Gentle Shell (Pi package)                         Chrome (Gentle Shell Browser)
same machine, or WSL2                             same machine, or Windows
─────────────────────────                         ─────────────────────────────
agent ─ browser_* tool ─► ws://127.0.0.1:487xx ◄─── extension (Origin chrome-extension://…
   (one port per session)                            + mutual proof of the shared token)
                                                       │ 1. tab must be in this session's group
                                                       │ 2. mode decides: allow / ask / refuse
terminal prompt ◄── "approve" request ◄────────────────┘ 3. ghost cursor glides, then real input (CDP)
"Deny" / "Allow once" / "Always …" ────────────────►   STOP (page or popup) ─► aborts the agent run
```

The decision lives in the extension; the terminal only shows the question. A tool cannot skip a check, change the mode or save a decision. The extension finds the sessions and the token through the helper `dev.gentle.shell`, so there is nothing to pair.

## Session discovery

There is no pairing code. Every 30 seconds, when Chrome starts and whenever you open the popup, the extension asks the helper for the token and the live Gentle Shell sessions, then:

- connects to each new session (the toolbar badge shows **ON**, or the number of connected sessions);
- closes the connection of a session that ended;
- redials a session whose port changed;
- leaves the others alone.

A session entry the helper lists that is not valid is skipped; the other sessions still connect. Gentle Shell records each session's name trimmed, without control characters, at most 60 characters, and "session" when empty. The token lives in `$XDG_CONFIG_HOME/gentle-chrome/token` (or `~/.config/gentle-chrome/token`, mode 0600), each session's record in `sessions/<id>.json` next to it, unless `GENTLE_CHROME_CONFIG_DIR` names another folder.

The popup shows how many sessions are connected in its status pill and has an **On/Off** switch ("Connect to Gentle Shell sessions"): Off closes every connection and stops connecting until you turn it On again.

### The HMAC handshake

The token itself never travels over the socket. On every connection both sides exchange random nonces and prove they know the token with an HMAC that also names the session: Gentle Shell proves it first, then the extension. If whatever listens on a session's port cannot prove it (another program took the port), the extension closes that connection, stops retrying it and lists it as `untrusted`; turning the switch Off and On tries again.

The bridge accepts a connection only from a `chrome-extension://` Origin that completes the challenge within 5 seconds and sends at most 4 KiB before it does. One extension at a time.

## The native messaging helper

Chrome starts the helper `dev.gentle.shell` when the extension asks for the sessions. The install writes it to `<folder>-host` next to the extension copy, and writes the config folder it resolved into it (`--config-dir`), because Chrome starts it with your normal environment, not Gentle Shell's. Only this extension may start it: its id is fixed by the `key` in the manifest. The helper runs the Node that ran the install.

| Platform | Launcher | Registration |
|----------|----------|--------------|
| WSL2 | `gentle-shell-host.bat`, which runs the helper in WSL through `%SystemRoot%\System32\wsl.exe` (a full path, so it works even when Chrome was started without System32 on its PATH) | Registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.gentle.shell` |
| Windows | A `.bat` that runs `node.exe` directly | Registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.gentle.shell` |
| Linux | Executable `gentle-shell-host.sh` (mode 0755) with safely quoted paths | `~/.config/google-chrome/NativeMessagingHosts/dev.gentle.shell.json`, plus `~/.config/chromium/NativeMessagingHosts/` when that Chromium folder exists |
| macOS | Executable `gentle-shell-host.sh` (mode 0755) with safely quoted paths | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.gentle.shell.json`, plus Chromium's when present |

- Registration paths come from the account's real home folder, not a redirected `$HOME`.
- `GENTLE_CHROME_NATIVE_HOSTS_DIR` names the one folder the manifest goes to on Linux and macOS (Brave, Edge, Vivaldi or another Chromium browser); it replaces the default list.
- `GENTLE_CHROME_PLATFORM` (`wsl`, `linux`, `darwin` or `win32`) overrides platform detection, for example to install for a Linux Chrome inside WSL through WSLg. Detection and the per-platform defaults live in `src/platform.ts`.
- `npm run install-extension` runs `node src/update.ts setup [folder]` and prints human-readable output. On WSL it needs a folder; without one it refuses and points to `scripts/install-extension.sh`. On Linux and macOS, `scripts/install-extension.sh` (no `wslpath` available) runs the same `setup`.
- **WSL distribution.** On WSL the helper starts the distribution `WSL_DISTRO_NAME` names. Inside a Gentle Shell session, where `PATH` may lack the Windows folders and `WSL_DISTRO_NAME` is unset, the script finds `cmd.exe` or `powershell.exe` in `C:\Windows\System32`, takes the distribution from `wslpath -w /` (the one running it) and prints it. If it cannot tell and the target is on a Windows drive, it stops: set `WSL_DISTRO_NAME` to the name `wsl.exe -l -q` lists and run it again. Chrome cannot reliably load an unpacked extension from a `\\wsl.localhost\…` path, which is why WSL copies it to a Windows folder.
- There is one helper per user, so the last install decides which config folder it reads; `/browser update` and automatic updates rebind it to the session that runs them. `/browser status` reads the install's files (it does not ask Chrome) to say whether the helper reads this session's folder.

## Self-update

The install stamps the copy with `build.json` and `build.js` (a hash of the extension's files) and records the folder in `~/.config/gentle-chrome/extension-target`. It also records it in your real `~/.config/gentle-chrome` (from the account's home, not `$HOME`; `GENTLE_CHROME_DURABLE_DIR` overrides it), so a Gentle Shell update that replaces its own config folder does not lose it.

Whenever the extension connects with another build than the checkout's, Gentle Shell copies the new files into that folder and asks the extension to reload itself as soon as no action is running (it retries every 30 seconds, up to 10 times). `/browser update` does the same on demand. The extension reports the build from `build.js`, which is part of its code: Chrome keeps running the code it cached until the extension reloads, even across browser restarts, so a stale copy reports its old build and gets reloaded.

An extension loaded before self-update existed cannot reload itself: Gentle Shell copies the files and asks you to press the reload icon on the Gentle Shell Browser card in `chrome://extensions` once. After that it updates itself.

## Policy reference

### The tab groups

- **One group per session.** Each Gentle Shell session gets its own pink group titled **Gentle · <session name>**. When two running sessions share a name, the later ones are **Gentle · <name> · 2**, **· 3**… A name that ends in "(ended)" ends in "(ended session)" in the title, so no live group looks like an ended one.
- A session can only read or act on tabs in its own group. Any other tab id, including a tab in another session's group, gets "Tab N is not in the Gentle Shell group".
- The agent never switches tabs for you: it opens and works in its tabs in the background.
- **Grant** a tab to a session by dragging it into that session's group. **Revoke** by dragging it out: the cursor and the debugger leave that tab at once.
- `browser_act` with `open` creates the session's group in your last focused window.
- A group you title exactly like a session's group yourself (for example "Gentle · docs") counts as granted to that session: it is adopted when its stored group is gone, unless another session owns it. A group whose title ends in " (ended)" is never adopted.
- **Ended sessions.** When a session ends, its group stays with its tabs and is renamed **Gentle · <name> (ended)**. No session ever uses it again. The extension remembers the live sessions, so a session that ended while Chrome or the extension was not running gets its group renamed at the next discovery.
- Actions run one at a time across all sessions.
- **Leaving the group stops an action.** Right before every input event the extension checks the tab again; if you dragged it out meanwhile (even during an approval prompt), the action fails with "Tab N left the Gentle Shell group; the action was cancelled." and nothing is sent. The debugger never attaches, or re-attaches, to a tab outside the group.
- **Tabs an agent action opens** (a `target=_blank` link, `window.open`, a middle click) are taken out of the group at once, even if Chrome put them there. The permission mode then decides, as for opening a page: allowed → it joins the group; denied, no answer or STOP → it is closed.
- **Tabs a group tab opens later**, with no agent action running, are quietly taken out of the group if Chrome puts them there when they open or within 2 seconds. Nothing is asked and the tab stays open. Drag it back into the group to grant it; that is not undone.
- Tabs opened from tabs outside the group are never touched.

### Permission modes

An older install's levels carry over: Supervised becomes Always ask, Autonomous becomes Remember my decisions.

| Mode | What it does |
|------|--------------|
| **Always ask** (`always`) | Asks before every acting step: opening or loading a page (`open`, `navigate`, `back`, `forward` and `reload` steps, a click that loads a page, a tab an action opens), and every click, typing, key press and scroll. |
| **Remember my decisions** (`remember`) | Asks like Always ask, but the prompt also offers **Always allow … on \<site\>** and **Always deny … on \<site\>**. A saved decision answers that site and kind of step from then on, without asking. |
| **Never ask** (`never`) | Asks nothing. Only the session's tab group and STOP limit it. The popup and `/browser level never` ask you to confirm first. File uploads are the exception: see [Uploading files](#uploading-files). |

### Kinds of step

Every acting step has a **site**, the host of the page it acts on (for opening a page, of the destination) in lower case without `www.`, and a **kind**, decided by the extension, never by the agent:

| Kind | In the prompt | When |
|------|---------------|------|
| `money` | payments and transfers | A control named pay, buy, purchase, order, place order, checkout, transfer or donate (also pagar, comprar, transferir, donar); typing into a card or bank field; submitting a form with one; any step on a page with card or bank fields, an embedded payment form or a pay/transfer submit button; a risky verb on a billing or payment methods page. |
| `irreversible` | deleting, passwords and security changes | A control named delete, remove (also eliminar, borrar, quitar); typing into a password or one-time code field; submitting a form with a password field; any step on a page with a password field or a delete submit button; a risky verb on a page about passwords, two-factor, account deletion or security. |
| `navigate` | opening pages | Opening or loading a page, and a tab an action opens. |
| `click`, `type`, `key`, `scroll` | clicks, typing, key presses, scrolling | Any other step of that kind. Scrolling is always `scroll`: it cannot pay or delete. |

When a step matches both, `money` wins over `irreversible`. What the detection found is shown on the prompt's `Why:` line.

### Saved decisions

- A decision is saved per site and kind. One kind never covers another: **Always allow clicks on mercadopago.com** still asks before a payment there, and nothing saved for `mercadopago.com` covers `mercadopago.com.ar`.
- A saved **allow** goes ahead without asking. A saved **deny** refuses without asking: "The user did not approve: … (saved rule: deny money on mercadopago.com)".
- The agent can still raise: `risky: true` asks even over a saved allow. A page whose content could not be read is never covered by a saved allow either.
- A page without a host (such as `about:blank`) has no site: in this mode it always asks and offers no saving.
- Only you save decisions: the extension accepts one only as the answer to a prompt that offered it.

### The prompt

The prompt appears in the Gentle Shell terminal with **Deny** (listed first, the default) and **Allow once**; in Remember my decisions also **Always allow \<kind\> on \<site\>** and **Always deny \<kind\> on \<site\>**. Anything else counts as no: no answer in 5 minutes, no terminal UI, Chrome disconnected, STOP, or an error. A denied step fails with "The user did not approve: …" and the agent is told not to retry it. Text from the page is cleaned before it reaches the terminal: control characters, bidi overrides and line separators are removed.

An approval covers that exact address and the server redirects of that request. Any other page load in the same action (a second navigation the page starts on its own, a script redirect) is decided again by the mode. A risky page is covered as a redirect only by that exact address or by the mode itself (Never ask, or a saved allow for its site).

### Risky actions

These decide a step's kind (`money`, `irreversible` or its plain kind) and its `Why:` line; whether it asks is up to the mode.

- Typing into a password, payment card, one-time code or IBAN/CVV field.
- Pressing Enter in a message box (textarea or rich editor).
- Submitting a form: Enter or a `type` step with submit inside a form, or clicking (or pressing Enter/Space on) a submit button. Search forms are the exception: a `role=search` landmark, a search field, an action address containing "search", or a single text field named `q`, `query`, `search` or `s`. A form with a password or payment field is always risky.
- Clicking a control, or pressing Enter or Space on a focused button or link, whose name says pay, buy, order, checkout, send, delete, remove, publish, post, transfer, confirm, unsubscribe, sign (not sign in/up/out/on), donate, cancel subscription, or the Spanish equivalents (pagar, comprar, enviar, eliminar, borrar, quitar, publicar, transferir, confirmar, firmar, donar).
- Input on a target the extension cannot inspect: no element there, an iframe, frame, embed or object, or an unnamed shadow-DOM component. (Tab, Shift+Tab and Escape are exempt.)

Right before pressing, the extension checks that the element under the cursor is still the target. If the page moved, it looks the element up once more and glides there; if it is still covered, the action fails with "The page moved under the cursor; take a new browser_snapshot." and nothing is pressed.

### Risky pages

Right before every click, typing, key press or scroll, the extension reads the page (main frame, visible elements only) and treats it as risky when it has:

- a password field;
- a payment card, one-time code or bank account field: autocomplete `cc-*` or `one-time-code`, or a name, id or label about card number, CVV/CVC, expiry, IBAN, routing or account number (also `tarjeta`, `vencimiento`, `cuenta`, `CLABE`, `CBU`);
- a form submit control whose name is one of the risky verbs above (pay, send, transfer, delete…);
- an embedded payment form from Stripe, PayPal, Mercado Pago, Adyen, Braintree, Checkout.com or Square;
- a title or heading about account security or billing: change password, two-factor, delete account, billing, payment methods, security (and `cambiar contraseña`, `verificación en dos pasos`, `eliminar cuenta`, `facturación`, `métodos de pago`, `seguridad`);
- content that cannot be read.

A page also counts as risky by its address when:

- its host starts with `admin`, or contains `bank`, `banking`, `banco`, `wallet` or `billing`;
- its path has a segment `checkout`, `billing`, `payment(s)`, `pay`, `admin`, `settings`, `security`, `password`, `account(s)` or `wallet`;
- its address cannot be read;
- it is on the built-in list of payment, mail, account and cloud console domains (not editable).

Before a navigation the destination's content is unknown, so only its address is named in the prompt. Right after a page loads, the extension reads it and tells the agent when it looks sensitive (`browser_snapshot` shows a `Risk:` line too); nothing pauses then, but the next action on that page is `money` or `irreversible` when its content says so.

**The agent can only raise risk.** `browser_act` takes an optional `risky` flag for every action but `scroll` and `upload`, which ignore it. `risky: true` makes that step ask in Always ask and Remember my decisions, even over a saved allow ("the agent marked this step as sensitive"); it has no effect in Never ask. `false`, or any other value, changes nothing, so the agent can never skip an approval the mode requires.

**The built-in list is not editable.** A page on it is reported to the agent as sensitive and named on the prompt's `Why:` line; it does not add a prompt by itself. An entry is a domain, which covers its subdomains, optionally with a path prefix such as `github.com/settings`. It covers payment providers, banks, webmail, account pages and cloud consoles (PayPal, Stripe, Mercado Pago, Google/Microsoft/Apple accounts, Gmail, Outlook, AWS, Azure, GCP…).

### Uploading files

`browser_act` with `upload` takes a `ref` and `files`, 1 to 10 absolute paths. Chrome's file dialog never shows: when `ref` is a file input, the files are set on it directly (`DOM.setFileInputFiles`); otherwise the extension intercepts the file chooser (`Page.setInterceptFileChooserDialog`), clicks `ref`, waits up to 5 seconds for the chooser and sets the files on the input that opened it. The interception ends right after, on errors and STOP too. A chooser that takes one file refuses several, and nothing is attached when no chooser opens.

- **Checked in the session first.** Each path must be absolute and name a readable regular file; symlinks are followed. When Gentle Shell runs in WSL, it is then converted to a path Chrome on Windows can read (`/mnt/c/…` becomes `C:\…`, anything else goes through `wslpath -w`). A refused file fails the whole step before anything reaches Chrome.
- **Sensitive files are never uploaded**, in any mode or chat, by the path given or the file it resolves to: anything inside `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `secrets`, `.password-store` or `keyrings`; files named `.env` or `.env.*`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `credentials`, `credentials.json`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` (and their `.pub`), `known_hosts`, `authorized_keys`, `.pgpass`, `.my.cnf`, `.bash_history`, `.zsh_history`, `.python_history`, `.psql_history` or `wallet.dat`; anything inside `.config/gcloud` or `.config/gh` (such as `hosts.yml`); `Login Data`, `Cookies` and `Web Data` inside a Chrome, Chromium, Edge or Brave profile (`User Data`, `.config/google-chrome`, `.config/chromium`…); and `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`, `.jks`, `.kdbx`, `.kdb`, `.ppk`, `.asc`, `.gpg` and `.ovpn` files. Case, and trailing spaces or dots that Windows strips (`.env.`), do not count. The agent is told not to retry. The check is by path, so a hard link or copy of a sensitive file under another name is not detected; the approval prompt is the remaining protection there.
- **Approval: uploads have their own rule, not the permission mode.** On `https://web.whatsapp.com`, when the chat open in that tab is on the [WhatsApp watch](#whatsapp-watch) allow list and exactly one row of the chat list has its name, the upload goes ahead without asking. Everything else always asks, in every mode including Never ask: other sites, other chats, a chat name that cannot be read or that two rows share. The prompt names the open WhatsApp chat (or the site, when there is none or its name cannot be read) and lists every file by name and path, plus the real path when a symlink points elsewhere (`tax.pdf (/tmp/vacation.jpg → /home/you/private/tax.pdf)`); it offers no "Always allow", and saved decisions do not apply. Right before the files are set, every upload checks again that the page origin and the open chat are still the ones allowed or approved; otherwise nothing is attached.
- Group confinement and STOP work as for every other step.

## WhatsApp watch

- **Switch:** `/browser watch on|off`, or the popup's **Answer new messages · <session>** switch. Turning it on asks you to confirm. It is kept by the extension, per session, so either side shows the other's change; the status bar shows `WhatsApp: watching`. It starts off in every new session and after Chrome or the extension restarts. Switching it on opens WhatsApp Web in the session's group when the group has none; messages already unread there do not ring.
- **Diagnosis:** `/browser watch` shows when the tab last read its chat list and the last ring.
- **Allow list:** names match as WhatsApp shows them, ignoring case and extra spaces. Other chats never ring. When two rows share an allowed name, neither rings. The open chat shows no unread count, so its messages do not ring.
- **Once per message:** a ring needs the unread count to rise; a typing or recording status in the preview never rings. A message that already rang never rings again, even when WhatsApp shows it unread again after the agent replied; each chat remembers its last 20 such messages. More unread messages in a chat that already had some always ring; only a chat that was read and then shows one unread message with exactly the same text as a remembered one does not ring. While a ring for a chat waits for the agent, more messages from that chat add no ring. Messages that arrive while the agent is busy ring after it finishes, and only if the chat still has unread messages. If it opens a chat with nothing after its last reply, it does not reply. The agent is asked to close the chat after replying, so its next message can ring.
- **How it wakes:** the extension calls the session's `whatsappMessage` over the authenticated connection; the Pi package sends a custom message with `triggerTurn` (a follow-up when the session is busy). The message quotes the chat's name and preview as untrusted data.
- **Reader:** `extension/whatsapp.js` is injected (`chrome.scripting`, host permission for `https://web.whatsapp.com/*` only) while the watch is on and after the tab reloads. It only reads the chat list and never changes the page; switching the watch off removes it.
- **Replies** are ordinary `browser_act` steps and follow the permission mode. **Files** follow [their own rule](#uploading-files).

## Safety model

| Layer | Guarantee |
|-------|-----------|
| Bridge | Listens on `127.0.0.1` only. Accepts a connection only from a `chrome-extension://` Origin that completes the HMAC challenge-response within 5 seconds and sends at most 4 KiB before it does; the token is never sent. The extension talks only to a listener that proved it knows the token. One extension at a time. |
| Group | Every tab-scoped request goes through the calling session's group check in the extension, repeated before every input event; the debugger attaches only to tabs in a live session's group. |
| Actions | One at a time across all tabs (the tools also run sequentially). |
| Policy | Decided in the extension from settings only you change: the popup, `/browser level` (which confirms before Never ask), `/browser rules`, and the Always allow/deny answers to its own prompts. |
| Sessions | The helper only answers this extension's fixed id. Each connection is bound to one session id; a session reads and acts only on its own group, and its approvals are asked in its own terminal. |
| Approval | Asked in the terminal of the session that started the action; any failure is a denial. |
| STOP | The **STOP** button on the page fails the running and waiting actions of the session acting on that tab ("Stopped by the user in Chrome."), removes the cursor from their tabs and aborts that session's run; other sessions' actions go on. When no other action is left it also detaches the debugger. The popup's **STOP** stops every session's actions, detaches the debugger and aborts every connected session's run. When a session disconnects, the extension stops only that session's actions, or removes the cursor and the debugger from its tabs. |
| Visibility | While the debugger is attached, Chrome shows its "started debugging this browser" bar. Cancelling it detaches; the next action attaches again. |

## Limitations in detail

- **Some page changes cannot be paused.** Navigation is paused only when a new document is requested from the network. In-page (SPA) route changes, pages restored from the back-forward cache and prerendered pages that Chrome activates never make that request. They are detected afterwards: the cursor label shows "Page changed without approval → …" and the agent is told. Service workers are bypassed during an action so their navigations do reach the check; for that the extension turns on the debugger's Network domain for the action's duration.
- **Late new tabs.** A tab you drag into the group within 2 seconds of a group tab opening it may be taken out once; drag it again.
- **Chrome restart.** A group whose session ended while the extension was not running is renamed "(ended)" at the next discovery.
- **A held new tab** whose web address does not show within 3 seconds (for example a blank `window.open`) is asked for in Remember my decisions even with saved allows: it has no site yet.

## Look and feel

The popup and the on-page cursor, highlight, label and STOP banner follow the [Gentleman Programming](https://gentlemanprogramming.com/) dark rose palette. The popup uses Iosevka, bundled in `extension/fonts/` (latin 400/700 from `@fontsource/iosevka` 5.3.0, SIL Open Font License 1.1, see `extension/fonts/OFL.txt`). Pages cannot load extension fonts without exposing them to every site, so the on-page overlay uses Iosevka Term or JetBrains Mono when installed and falls back to the system monospace font.

## Source map

```sh
npm install
npm test            # unit tests (Node 22.18+, no build step)
npm run typecheck   # type check (src, test and the extension JS they import)
```

| Path | Contents |
|------|----------|
| `src/index.ts` | Pi extension entry: `/browser` command, tools, approval prompt wiring. |
| `src/bridge.ts`, `src/token.ts` | Authenticated loopback WebSocket and the shared token. |
| `src/sessions.ts`, `src/host.ts` | Per-session ports and records; the native messaging host that lists them. |
| `src/platform.ts` | Platform detection, default extension folders and native messaging host folders. |
| `src/update.ts` | Build id, the extension copy and helper install (`setup` and `install`), and self-update. |
| `src/tools.ts`, `src/approval.ts` | The `browser_*` tools and the terminal approval prompt. |
| `extension/background.js` | Service worker: wiring, discovery, popup requests. |
| `extension/lib/sessions.js` | Discovery reply check, one connection and group per session, per-session request table, approval and STOP routing. |
| `extension/lib/group.js` | The tab group boundary. |
| `extension/lib/policy.js`, `navguard.js` | Permission modes, kinds of step, saved decisions, risky pages and actions, the navigation pause and new-tab hold. |
| `extension/lib/actions.js`, `overlay.js` | Input through CDP and the ghost cursor. |
| `extension/whatsapp.js` | The WhatsApp Web chat list reader. |
| `scripts/install-extension.sh` | The install on WSL; on Linux and macOS it runs `npm run install-extension`'s `setup`. |
