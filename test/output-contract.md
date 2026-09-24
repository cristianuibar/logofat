# Pi output contract (Logofăt `/route`)

Probed 2026-09-24 against the installed host **Pi 0.87.1** (`pi --version` → `0.87.1`; Bun-compiled binary at `~/.local/share/mise/installs/pi/0.87.1/pi/pi`, which loads extensions in-process through jiti) on Node v24.5.0. All probes used throwaway stub extensions under `/tmp/nabu-probe/`. None of them were committed.

This file is the source of truth for three things: how `/route` output reaches the user in each Pi mode, the isolation flag set every Pi check uses, and the constants embedded in `test/lib/pi-json.mjs`.

## Contract constants

| Constant | Value | Used by |
|----------|-------|---------|
| `customType` literal | **`logofat`** | Every `pi.sendMessage` call in `src/` and every fixture. The helper rejects any other value. |
| Expected message role | `custom` | `test/lib/pi-json.mjs` `EXPECTED_ROLE` |
| Command error signature (stderr) | `Extension error (command:<name>): <message>` (regex `^Extension error \(command:[^)]*\): `) | `test/lib/pi-json.mjs` `STDERR_ERROR_SIGNATURE` |
| JSON command-error event | **None.** This host emits no JSON command-error event. The only signal is the stderr error signature. | Checks never look for a JSON error literal. |
| Benign stderr baseline (`--print --mode json`, success) | **Empty.** Every successful probe wrote 0 bytes to stderr. | `test/lib/pi-json.mjs` `BENIGN_STDERR_LINES = []` |
| `display` field | Observed as `true` in probes. It is **not contractual**, and the helper ignores it. | n/a |

## Per-mode channel table

| Mode (`ctx.mode` / `ctx.hasUI`) | `ctx.ui.notify(text, "info")` | factory-captured `pi.sendMessage({customType, content, display})` | handler return value | Rule for `/route` |
|---|---|---|---|---|
| TUI (`tui` / `true`) | **Visible**: plain text, dim, multi-line, word-wrapped, not truncated | Would also render and enter model context (double display plus context leak) | Discarded | notify only |
| RPC (`rpc` / `true`) | Forwarded as an `extension_ui_request` `method:"notify"` event | Emitted as `message_start`/`message_end` `role:"custom"` and **persisted into session messages, which reach the model** | Discarded | notify only (`hasUI` is true) |
| `--print --mode json` (`json` / `false`) | **Invisible**: no JSON event | Visible as `message_start` + `message_end` events with `role:"custom"`, `customType`, `content`, `display`, `details` | Discarded | notify **plus** `pi.sendMessage` |
| `--print` text (`print` / `false`) | Invisible | Invisible. Stdout and stderr are both empty. | Discarded | Not used by any check. There is no channel for void handlers. |

**Emit rule (all handlers):** always call `ctx.ui.notify(text, "info")`. Call factory-captured `pi.sendMessage({ customType: "logofat", content: text, display: true })` **only when `!ctx.hasUI`**. Never call `ctx.sendMessage`, which does not exist on `ExtensionCommandContext` and throws `TypeError`. Never use `ctx.ui.custom`, which is prohibited: custom components do not forward over RPC and do nothing in json/print modes. Never rely on the return value.

**Test-mode consequence:** every automated Pi check uses `--print --mode json`. TUI is covered by the manual UAT gate in 01-04.

## Probe rows

Every row below used the isolation set in the next section unless the row says otherwise. Outputs are quoted verbatim, and long JSON lines are shown whole.

### (a) Dispatch in print mode is credential-free

A slash command dispatches in `pi --print --mode json` with **no model turn and no credentials**. Row (g) proves this under `env -i` with no API-key variables at all. Pi only creates `auth.json`/`models-store.json` under the temp `PI_CODING_AGENT_DIR`. No smoke check needs a model or API key.

### (b) Channel visibility (json mode) and return-value discard

Stub `channels.ts`: calls `ctx.ui.notify("NOTIFY-SENTINEL **bold** …")`, then `pi.sendMessage({customType:"logofat", content:"SEND-SENTINEL mode=… hasUI=… args=[…]", display:true, details:{d:"DETAILS-SENTINEL"}})`, then tries `ctx.sendMessage(...)`, then `return "RETURN-SENTINEL"`.

```sh
timeout 60 pi --no-session --session-dir "$SESS" --no-extensions --no-skills --no-context-files --no-themes \
  --extension ./channels.ts --print --mode json "/probe  hello   world " > b.out 2> b.err </dev/null   # rc=0
```

stdout (`b.out`):

```
{"type":"session","version":3,"id":"01a0d367-f811-76c8-9e1b-2308354c2d76","timestamp":"2026-09-24T12:33:21.425Z","cwd":"/tmp/nabu-probe"}
{"type":"message_start","message":{"role":"custom","customType":"logofat","content":"SEND-SENTINEL mode=json hasUI=false args=[ hello   world ]","display":true,"details":{"d":"DETAILS-SENTINEL"},"timestamp":1790253201582}}
{"type":"message_end","message":{"role":"custom","customType":"logofat","content":"SEND-SENTINEL mode=json hasUI=false args=[ hello   world ]","display":true,"details":{"d":"DETAILS-SENTINEL"},"timestamp":1790253201582}}
{"type":"message_start","message":{"role":"custom","customType":"logofat","content":"CTX-SENDMESSAGE=threw:TypeError typeof=undefined","display":true,"timestamp":1790253201582}}
{"type":"message_end","message":{"role":"custom","customType":"logofat","content":"CTX-SENDMESSAGE=threw:TypeError typeof=undefined","display":true,"timestamp":1790253201582}}
```

stderr (`b.err`): empty (0 bytes).

Findings:
- `ctx.ui.notify` produces **no** JSON event (`NOTIFY-SENTINEL` is absent).
- `pi.sendMessage` produces `message_start` and `message_end` events with `role:"custom"`. `content` is passed through as given (here a string).
- `ctx.sendMessage` is `undefined`, and calling it throws `TypeError`.
- `RETURN-SENTINEL` appears nowhere, so the host **discards the handler return value**.
- In json mode, `ctx.mode === "json"` and `ctx.hasUI === false`.
- **Argument passing:** `"/probe  hello   world "` arrives as `args = " hello   world "`. Pi strips the command name and exactly one separating space, and preserves every other space, including the trailing one. The handler therefore trims only to classify `--help`/`-h`/blank args and never splits `args`.

### (c) Throwing handler: error signature

Stub `throw.ts`: `handler: async () => { throw new Error("INTENTIONAL-PROBE-THROW"); }`

```sh
timeout 60 pi … --extension ./throw.ts --print --mode json "/throwprobe" > c.out 2> c.err </dev/null   # rc=0 (!)
```

stdout: only the session header.

```
{"type":"session","version":3,"id":"01a0d367-f98f-7417-a4d6-4611939c38ca","timestamp":"2026-09-24T12:33:21.807Z","cwd":"/tmp/nabu-probe"}
```

stderr:

```
Extension error (command:throwprobe): INTENTIONAL-PROBE-THROW
```

**Error signature:** a thrown command handler exits **0** and writes `Extension error (command:<name>): <message>` to **stderr only**. Pi source `modes/print-mode.ts:102` uses `console.error`. **This host has no JSON command-error event.** So the exit code never proves success. Every check captures stdout and stderr to **separate files**, never `2>&1`, and asserts through `test/lib/pi-json.mjs`, which fails with exit 7 on this signature.

### (d) jiti resolves `.ts`-suffixed relative imports

Stub `twofile.ts` does `import { HELPER_MARK } from "./helper.ts";` and emits `HELPER_MARK` via `pi.sendMessage`.

```sh
timeout 60 pi … --extension ./twofile.ts --print --mode json "/twofile" > d.out 2> d.err </dev/null   # rc=0
```

```
{"type":"message_start","message":{"role":"custom","customType":"logofat","content":"JITI-TS-SUFFIX-OK","display":true,"timestamp":1790253202370}}
```

stderr: empty. jiti loads multi-file extensions that use `.ts` suffixes in relative specifiers, the same form Node 24 type stripping requires. So `src/` modules use `./x.ts` imports, and one import form serves both Pi and `node --test`.

### (e) RPC mode: context leakage, no display-only option

```sh
( printf '%s\n' '{"id":"r1","type":"prompt","message":"/probe rpc"}'; sleep 2; printf '%s\n' '{"id":"r2","type":"get_messages"}'; sleep 2 ) \
  | timeout 30 pi --no-session --session-dir "$SESS" --no-extensions --no-skills --no-context-files --no-themes \
      --extension ./channels.ts --mode rpc > e.out 2> e.err                                          # rc=0
```

stdout (truncated to the relevant lines):

```
{"type":"extension_ui_request","id":"6f6ce573-5723-4c0c-b0ae-f946fade008c","method":"notify","message":"NOTIFY-SENTINEL **bold** args=[rpc]","notifyType":"info"}
{"type":"message_start","message":{"role":"custom","customType":"logofat","content":"SEND-SENTINEL mode=rpc hasUI=true args=[rpc]",…}}
{"id":"r1","type":"response","command":"prompt","success":true}
{"id":"r2","type":"response","command":"get_messages","success":true,"data":{"messages":[{"role":"custom","customType":"logofat","content":"SEND-SENTINEL mode=rpc hasUI=true args=[rpc]",…},…]}}
```

Findings (P4):
- In RPC, `ctx.mode === "rpc"` and `ctx.hasUI === true`. `notify` is forwarded to the client as `extension_ui_request`.
- The custom message is **persisted into the session messages**. Pi source `core/messages.ts` `convertToLlm` turns every `role:"custom"` message into a `user` message **unconditionally**. It never checks `display`, and only `details` stays out of model context.
- `pi.sendMessage` options are only `{ triggerTurn?, deliverAs? }` (Pi source `core/extensions/types.ts:1483-1486`). There is **no display-only or exclude-from-context option**. `excludeFromContext` exists only on `BashExecutionMessage`.
- **Therefore the gate is `!ctx.hasUI`, not `ctx.mode !== "tui"`.** When any UI is attached (TUI or RPC), notify alone reaches the user, and a custom message would double-display and put binary paths into model context.

### (f) Notify rendering is plain text

Source (verified): TUI `notify(msg, "info")` → `showExtensionNotify` → `showStatus(msg)` → `new Text(theme.fg("dim", message), 1, 0)` (`modes/interactive/interactive-mode.ts:3695-3712`). `Text` is a word-wrapping multi-line component with **no markdown parsing** (`packages/tui/src/components/text.ts`).

Live TUI probe (tmux, 100x60, isolated flags plus `--offline`): stub `tui.ts` notifies a 32-line message whose first line is `**Bold heading:** mode=… hasUI=…`, followed by 30 rows, each carrying a 90-char path, and ending with `LAST-LINE-SENTINEL`.

```sh
tmux new-session -d -s nabuprobe -x 100 -y 60 "PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR pi --no-session --session-dir $SESS --no-extensions --no-skills --no-context-files --no-themes --offline --extension /tmp/nabu-probe/tui.ts"
tmux send-keys -t nabuprobe -l '/tuiprobe x'; tmux send-keys -t nabuprobe Enter
tmux capture-pane -p -S -200 -t nabuprobe
```

Captured pane (excerpt):

```
 **Bold heading:** mode=tui hasUI=true
 - line 1
 /a/very/long/path/segment/that/should/wrap/in/a/narrow/terminal/if/pi/wraps/it/properly/end1
 …
 - line 30
 /a/very/long/path/segment/that/should/wrap/in/a/narrow/terminal/if/pi/wraps/it/properly/end30
 LAST-LINE-SENTINEL
```

Findings:
- `**` renders **literally**, so notify has no markdown. `/route` notify text uses the **plain-text variant** of the UI-SPEC copy, with no `**` markers.
- Multi-line messages render in full and wrap long lines. No truncation occurred at 32 lines, so provider rows and paths are never cut.
- In TUI, `ctx.mode === "tui"` and `ctx.hasUI === true`.
- Source note: `showStatus` **replaces** the previous status line when two notifies arrive back to back. Each `/route` response is therefore emitted as **one** notify call with the full multi-line text, never as several calls.

### (g) Minimal-PATH launcher survival

The fixture PATH contains only symlinks to the real `pi` and `node` binaries, and the environment is otherwise empty. This also proves row (a): no API keys are present.

```sh
FIX=$(mktemp -d); ln -s "$(readlink -f "$(which pi)")" $FIX/pi; ln -s "$(readlink -f "$(which node)")" $FIX/node
H=$(mktemp -d); SESS=$(mktemp -d)
timeout 60 env -i HOME=$H PATH=$FIX PI_CODING_AGENT_DIR=$H/agent \
  pi --no-session --session-dir "$SESS" --no-extensions --no-skills --no-context-files --no-themes \
     --extension ./channels.ts --print --mode json "/probe x" > g.out 2> g.err </dev/null            # rc=0
```

```
{"type":"message_start","message":{"role":"custom","customType":"logofat","content":"SEND-SENTINEL mode=json hasUI=false args=[x]",…}}
```

stderr: empty. The Bun-compiled `pi` binary survives a PATH that holds only `pi` and `node`, with no shell, no mise shims, and no credentials. Note that `timeout` must wrap `env -i`, not the other way round, because `env -i` clears PATH before looking up `timeout`.

### (h) Benign stderr baseline

Across rows (b), (d), and (g), plus the 01-01 task-3 runs, a successful `--print --mode json` run writes **0 bytes** to stderr. The baseline is the empty set. Any stderr line fails the helper: exit 7 for the error signature, exit 8 for anything else.

### Stdin redirect (P1): `</dev/null` is mandatory

```sh
( sleep 5 | timeout 3 pi … --extension ./channels.ts --print --mode json "/probe x" > p1.out 2> p1.err )   # rc=124, 0 bytes out
echo "piped data" | timeout 30 pi … --extension ./channels.ts --print --mode json "/probe x"               # rc=1
```

The second command's stderr:

```
No API key found for the selected model.

Use /login to log into a provider via OAuth or API key. See: …
```

- An **open stdin pipe hangs** print mode, because Pi reads stdin before dispatching. It was killed by `timeout` with rc=124 and produced no output. Agent Bash tools run with an open pipe, so a bare invocation hangs.
- **Piped data re-targets the prompt:** stdin text is prepended to the message, which turns `/route …` into a model turn that fails on credentials.
- Therefore **every** Pi invocation uses `</dev/null` **and** a per-call `timeout 60`. These are requirements, not hygiene.

## Verified isolation flag set (use verbatim)

All flags were verified in the installed `pi --help` (0.87.1): `--no-session`, `--session-dir <dir>`, `--no-extensions`/`-ne` (explicit `-e`/`--extension` paths still load), `--no-skills`/`-ns`, `--no-context-files`/`-nc`, `--no-themes`, `--extension`/`-e <path>`, `--print`/`-p`, `--mode text|json|rpc`.

```sh
export PI_CODING_AGENT_DIR=$(mktemp -d); SESS=$(mktemp -d)
timeout 60 pi --no-session --session-dir "$SESS" --no-extensions --no-skills --no-context-files --no-themes \
  --extension ./src/index.ts --print --mode json "/route hello" > "$OUT" 2> "$ERR" </dev/null
node test/lib/pi-json.mjs "$OUT" "$ERR" "$MARK"     # the verdict; never the pi exit code
rm -rf "$PI_CODING_AGENT_DIR" "$SESS" "$OUT" "$ERR"
```

| Element | Why |
|---------|-----|
| temp `PI_CODING_AGENT_DIR` | No user settings, auth, or installed packages leak in. Pi writes only `auth.json`/`models-store.json` there. |
| `--no-session` + temp `--session-dir` | Nothing is persisted to the user's session store. |
| `--no-extensions` (`-ne`) | Only the extension under test loads. |
| `--no-skills` (`-ns`), `--no-context-files` (`-nc`), `--no-themes` | No discovery of user or project resources. |
| `--print --mode json` | The only mode with a machine-readable channel for void handlers. |
| `</dev/null` | Mandatory (P1): prevents both the stdin hang and the prompt re-targeting. |
| `timeout 60` per call | Mandatory (P1): bounds any hang. |
| separate `> out 2> err` | The error signature lives on stderr only, and merging with `2>&1` would corrupt the JSON stream. |

## Assertion helper

`test/lib/pi-json.mjs <stdout-file> <stderr-file> <expected-marker>` is the single assertion path for every Pi check in this phase (01-01, 01-03, 01-04). It:

1. rejects an empty or whitespace-only marker (exit 2)
2. parses stdout as line-delimited JSON and rejects non-JSON lines (exit 4) and zero events (exit 5)
3. requires **one** message whose `role === "custom"` **and** `customType === "logofat"` **and** decoded `content` (a string, or the joined `text` parts of an array) contains the exact marker, all in the same message. `details` and other metadata are never searched, and `display` is ignored (exit 6 otherwise).
4. rejects the stderr error signature (exit 7) and any stderr line outside the empty benign baseline (exit 8).

Markers are always derived from the module under test with a `node -e` import, never pasted.
