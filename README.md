# Logofăt

Logofăt is a coding workflow and, by v1, a harness. A piece of work comes in as a petition. The chancery reads it, decides which office should do it, writes the decision down, watches the work, and closes the matter when the result matches the order.

v0.1 is the first duty of that office, inside Pi. `/route <prompt>` finds the harnesses on the machine, asks Jev which one should take the job and at what effort, runs it, and streams a short status back into the Pi session. **muse** and **claude** are the first two clerks. The command is how a matter is assigned. The product is the office that carries the matter from the petition to a shipped result.

## How to read it

Three syllables, stress on the last: **lo-go-FĂT**.

The *ă* is the vowel in the second syllable of *sofa*. The package name and the domain drop the diacritic, so both are spelled `logofat`, and both are still read lo-go-FĂT.

## The name

A *logofăt* was the head of the princely chancery in Moldavia and Wallachia. He received the petition, laid it before the council, had the charter drawn up, and kept the prince's seal. A Latin act calls that office *cancellarius*. The word comes from Greek *logothetēs*: the one who sets the word down.

## Why this name

The chancellor's work is the whole matter. He receives the petition, puts it before the council, has the charter drawn up, keeps the seal, and sends the work to the right office. Logofăt is built toward that shape.

Two projects set the pattern.

[GSD Core](https://docs.opengsd.net/core/introduction) is the workflow. It sits on a coding agent and runs each milestone as a loop: discuss the decisions, plan the work in a fresh context, execute it, verify that what was built matches the order, then ship. The record is written to disk, so a new session inherits the charter instead of the conversation.

[GSD Pi](https://docs.opengsd.net/pi/introduction) is the harness. It is a local-first coding agent. A goal becomes milestones, slices, and tasks, and the agent plans, implements, verifies, and commits until the milestone is done or a person steps in. You can let it run, or walk it one unit at a time.

v1 of Logofăt is both: the workflow that carries a piece of work from decision to shipped code, and the harness that can run that workflow itself. Choosing muse, claude, or a later harness stays one act of the office. The same office keeps the charter, checks the work, and closes the matter.

The project was first called nabu. That name was already used by other software, including a coding-agent tool, so it was changed. Logofăt is the office this program is.

## Status

Not shipped. v0.1 proves the assignment: detect the local harnesses, ask Jev, run the one it picks, and show progress in Pi. v1 is the full workflow and the harness.

## Install

From a local checkout:

```sh
pi install /path/to/logofat
```

Pi loads the extension from that path (nothing is copied). Pick up a newer checkout later with:

```sh
pi update --extensions
```

That refreshes extension packages only — bare `pi update` updates Pi itself. Packages execute extension code inside your sessions, so review the source before installing.

## Jev API key

`/route` asks Jev (TypeSafe System One) which harness should take the prompt. Jev needs a TypeSafe API key. Provide it one of two ways:

- `TYPESAFE_API_KEY` environment variable (restart Pi after setting it), or
- `logofat.typesafeApiKey` in Pi's agent `settings.json` (no restart needed):

```json
{ "logofat": { "typesafeApiKey": "YOUR_KEY" } }
```

The environment variable wins when both are set. The key is read fresh on every `/route` call and travels only as the `Authorization` header of the Jev request — it never appears in the transcript, logs, or error output.

## What /route sends to Jev

Each `/route <prompt>` call sends your prompt verbatim plus the available harnesses as `{id, version}` pairs. It never sends binary paths, file contents, or environment variables. The request also carries short capability descriptions of the available harnesses, static text from a versioned in-code map.

Note: because the prompt goes to Jev verbatim, anything pasted into it — including secrets — is sent along. Keep credentials out of the prompt.

## When Jev is unreachable

If Jev can't be reached, /route fails loudly instead of guessing: each failure — timeout, unreachable network, rate limit, server error, rejected key or request, unusable answer, unavailable choice — renders its own guidance block saying what happened and what to do next. /route never hangs waiting for Jev: the worst case is about 46.5 seconds (3 attempts with backoff), after which it reports the failure. The Pi session stays usable — fix the cause and re-run /route.

## Decision log (stderr)

Every /route call that reaches Jev writes one JSON line to stderr recording the outcome: the outcome flag, chosen harness, effort, difficulty score, Choice confidence and probabilities, Score confidence, gating verdict (auto, confirm, or refuse), and the Jev call time in milliseconds — or, on failure, just the outcome flag, the failure class, and the timing. Failure records never carry confidence figures. The record never contains the prompt, the API key, binary paths, versions, or response bodies. In TUI mode Pi colorizes stderr output, so strip ANSI escapes before parsing the line as JSON.

## Run logs

Every settled run writes its captured stdout and stderr to one log file holding two labeled sections (`--- stdout ---`, then `--- stderr ---`). The file lives in a private per-user directory under the OS temp directory as `logofat-<uid>/logofat-<run-id>.log` (encoded username on Windows), and the transcript's report block points at it with an absolute path. UTF-8 output preserves code whitespace and punctuation; transcript excerpts remove terminal controls and use literal code blocks in markdown. The header carries run metadata and any cleanup warning — never prompt text, key material, or binary paths.

Collection is capped at 1 MiB total across both streams; bytes past the cap are dropped but counted, and the log marks each capped stream. Transcript byte limits keep the newest lines (or a UTF-8-safe suffix of an oversized final line). Pruning always protects the current log and retains at most 19 other owned regular logs by modification time; symlinks and other users' files are excluded. Writing or pruning failures never throw and never fail the run — when the log is unavailable, the transcript says so instead of naming a path.

## Running on a harness

High-confidence routes run automatically: the prompt goes to the selected harness at the Jev-chosen effort, and the transcript shows a tail of the run's output plus a pointer to the full log file. Medium-confidence routes ask first — in an interactive session a dialog names the harness, effort, and confidence against the auto-run threshold, and the run starts only on confirmation. Declining, dismissing, or missing the dialog leaves nothing running. In headless modes (`--print`, JSON) there is no dialog, so medium-confidence routes fail closed with guidance to re-run in an interactive session. Low-confidence routes refuse execution unless a previously successful harness is still available in this session: with usable numeric confidence, they automatically stay on that harness and disclose the exception. Unusable confidence always refuses execution.

After a successful run, session stickiness keeps that harness unless Jev gives a challenger a probability advantage greater than 0.15. The report says whether the route stayed or switched. Cancellation preserves the incumbent; other unsuccessful outcomes clear it.

While a run is in progress, interactive Pi shows a live status line naming the harness, the elapsed time, the output line count, and the latest output line. The harness name is colored per harness (cyan for muse, magenta for claude). Headless modes have no status line — the run-start notice and the final report are the whole record.

Every report that names a chosen harness also carries one line saying why: the winner's Jev probability against the runner-up's, plus the routing confidence. When the figures are unusable the line degrades to the winner and confidence only. Refused routes carry no explanation — the top pick was not used, so explaining it would mislead.

Every run is bounded: a run that exceeds the 10 minutes wall-clock limit is stopped and reported as timed out, with its partial output. In interactive Pi, press **Ctrl+Alt+X** to cancel all Logofăt routes, including while Pi's model is idle. The shortcut appears in Pi's extension shortcut list and the run-start notice. It also cancels pending routing and confirmation. When a model-turn abort signal exists, it cancels the route too. Headless runs have the timeout and session-shutdown controls; the keyboard shortcut is interactive only.

Quitting, reloading, or replacing the session cancels pending routes before draining running children. On Linux, Logofăt tracks descendants through `/proc`, rechecks PID start times before signaling, and awaits one shared SIGTERM-to-SIGKILL cleanup sequence. It never signals Pi's shared process group. Snapshot tracking cannot catch a descendant that forks and reparents entirely between scans, and checking identity before a signal is not an atomic kernel handle. Other platforms currently terminate only the direct child and report a cleanup warning. Bounded cleanup failures also produce a warning in the report and log; these limits mean absolute orphan-free execution is not guaranteed.

## Providers refresh

`/route` detects harnesses once per Pi session and reuses the result. If you install, remove, or upgrade a harness mid-session, re-detect without restarting:

```text
/route-providers
```

It prints the fresh provider list plus what changed since the last detection — per harness: newly available or unavailable, version changes, and binary-path changes — or a single line when nothing changed. When refresh runs before anything has detected harnesses in the session, there is no previous result to compare against, so it shows the list plus a one-line note instead of a diff. When no harnesses are available it appends the same setup guidance `/route` shows.
