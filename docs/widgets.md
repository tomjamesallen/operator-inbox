# Widgets

A widget is a small command you configure, which `serve` runs on a timer and whose output the sidebar shows as a chip: the load on this machine, how full a disk is, how many jobs wait in a build queue, how much of a quota is used. Each chip is a coloured strip, a line with the widget's label and its state, then a few lines of its output. Hover over it, click it, or focus it and press Space or Enter, and a popover shows every line.

With one machine, the widgets sit at the top of the sidebar, under the search and above `All`. With **Inbox machines** configured, each machine's widgets sit in its own fold, above its Inboxes.

Widgets are optional. With no `widgets.json`, the sidebar shows none.

## The file

Widgets live in `~/.config/operator-inbox/widgets.json` (under `$XDG_CONFIG_HOME` when that is set), beside `macros.json`. Serve reads it fresh on every read, so an edit shows within a poll or two, with no restart.

```json
{
  "path": ["~/bin", "/opt/homebrew/bin"],
  "widgets": [
    { "label": "Load", "command": "uptime | sed 's/.*load averages*: //'", "intervalSeconds": 30 },
    { "label": "Disk", "command": "df -h / | tail -1 | awk '{print $5 \" used of \" $2}'", "intervalSeconds": 300 },
    {
      "id": "builds",
      "label": "Build queue",
      "command": "build-queue status --json",
      "format": "json",
      "lines": 2,
      "text": "{{waiting}} waiting, {{running}} running",
      "detail": "{{#jobs}}{{name}}: {{state}}\n{{/jobs}}{{^jobs}}nothing queued{{/jobs}}",
      "tone": { "from": "waiting", "above": { "5": "warn", "20": "bad" } }
    }
  ]
}
```

### `path`

A list of folders, put in front of serve's own `PATH` for every widget's command, so a tool installed outside it needs no full path in each command. A leading `~` is the home folder. When serve has no `PATH` of its own, the folders go in front of `/usr/bin:/bin:/usr/sbin:/sbin`. Optional.

The launch agent runs serve with the `PATH` `scripts/setup.sh` wrote into its plist, which is shorter than your shell's. A command that works in your terminal may not be found by serve: `path` is where its folder goes.

### A widget's fields

| Field | What it is | Default and limits |
| :-- | :-- | :-- |
| `label` | The name on the chip. | Required; not blank. |
| `command` | The shell command, run as `/bin/bash -c <command>`. Pipes, `&&` and quoting all work as they do in bash. | Required; not blank. |
| `id` | The widget's handle: it names its cached run and is what the page asks to run. | The label lower-cased, with every run of other characters a `-` (`Build queue` is `build-queue`). Lower-case letters, digits, `-` and `_`, from a letter or digit, at most 64. Unique in the file. |
| `intervalSeconds` | How long after one run ends the next one starts. | 60; at least 5. |
| `timeoutSeconds` | How long a run may take before serve ends it. | 10, or the interval when that is shorter; at least 1. |
| `format` | How the output is read: `text` or `json` (below). | `text`. |
| `lines` | How many lines of output the chip shows. | 1; a whole number from 1 to 4. |
| `text` | A `json` widget's template for its first line (below). | None. Only a `json` widget takes it. |
| `detail` | A `json` widget's template for the lines under it. | None. Needs `text` beside it. |
| `tone` | A `json` widget's rule for its colour. | None. Needs `text` beside it. |

Each entry is checked on its own. One with a problem is dropped, and the rest still run: `widgets.2.intervalSeconds — at least 5`. A key no widget takes is named, and ignored, and the widget kept: `widgets.0.interval — not a widget key: ignored`, so a misspelt key never leaves a default in force unremarked. Only a file that is not JSON, or not `{ "widgets": [ … ] }`, fails as a whole, and then no widget runs. The sidebar says how many problems there are under the chips (`widgets.json: 2 problems`), and lists them on hover.

## The two formats

### `text`

The command's output, as it prints it. Bold, dim, italic, underline and the sixteen foreground colours of ANSI escapes are kept, drawn in the theme's own colours; every other escape (256 and true colour, backgrounds, cursor movement, links) and every other control character is dropped. The output is always text, never HTML. Line one is the first line of output, line two the second, and so on, up to `lines`.

### `json`

The command prints one JSON object, the envelope:

```json
{ "text": "41 of 100 used", "tone": "ok", "detail": "renews on the 1st\nlast checked 09:12" }
```

| Key | What it is |
| :-- | :-- |
| `text` | The first line. Required. |
| `tone` | Its colour: `ok` (green), `warn` (orange), `bad` (red), `info` (blue) or `muted` (grey). Optional. |
| `detail` | The lines under it. Optional. |

`text` and `detail` are read as `text` output is, ANSI escapes and all. Output that is not an envelope is shown as plain text, in red, with a note in the popover saying why (`not JSON`, `no "text"`).

## Templates

A command that already prints JSON of its own needs no envelope: a `json` widget with a `text` template maps the command's JSON to the envelope in serve. The templates are logic-less, in the style of Mustache, and make plain text.

| Tag | What it prints |
| :-- | :-- |
| `{{a.b}}` | The value at a dotted path. Array indexes are path segments: `{{jobs.0.name}}`. |
| `{{.}}` | The current item, inside a section. |
| `{{#a}}…{{/a}}` | For a list, the inside once per item, with the item as the scope. For anything else truthy, the inside once, with an object pushed as the scope. For false, `null`, `0`, `""`, an empty list or a missing path, nothing. |
| `{{^a}}…{{/a}}` | The inside once when `a` is falsy, empty or missing. Beside `{{#a}}…{{/a}}`, it is the else. |

So a loop is a section over a list, and an if/else is a section and an inverted section on the same path:

```text
{{#jobs}}{{name}} ({{state}})
{{/jobs}}{{^jobs}}nothing queued{{/jobs}}
```

Output that is not JSON fails the run (`the command did not print JSON`), as does JSON cut short by the 8 KB cap. A path is looked up in the innermost scope first, then outwards. A path missing where a value prints fails the run with `template: no value at <path>`, so a renamed field shows as the widget's error rather than as a blank; so does printing an object or a list as a value. A path missing inside a section is falsy, so an optional field needs no guard. A template that does not parse (a section never closed, or closed by another name) is a problem with the entry, found when the file is read.

### Tone rules

A tone comes from the data, with no comparison in a template. `from` is a dotted path, and then one of:

- `map`: the value's tone, by its text. `{ "from": "state", "map": { "green": "ok", "amber": "warn", "red": "bad" } }`. A value the map does not name has no tone.
- `above`: number thresholds, the highest one the value is at or above winning, and `ok` below them all. `{ "from": "used", "above": { "75": "warn", "90": "bad" } }`: 74 is `ok`, 75 is `warn`, 95 is `bad`.

A missing path, or a value `above` cannot compare because it is not a number, fails the run and names the path.

A JSON quota as a widget, from a command that prints `{"used": 41, "of": 100}`:

```json
{
  "label": "Quota",
  "command": "quota-tool --json",
  "format": "json",
  "text": "{{used}} of {{of}} used",
  "tone": { "from": "used", "above": { "75": "warn", "90": "bad" } },
  "intervalSeconds": 600
}
```

## How runs are scheduled

- **One run at a time per widget.** A widget runs, then waits its `intervalSeconds` from that run's end, then runs again, so a slow command never overlaps itself. A run asked for while one is going waits for it to end, and asking again while it waits is the same one run.
- **The timeout.** A run still going after `timeoutSeconds` is ended: SIGTERM to its whole process group, so the commands of a pipeline go with it, then SIGKILL 1.5s later to whatever is left. The next run waits until the group is gone.
- **The output kept.** The first 8 KB of stdout; the rest is read and dropped, and the popover says the output was cut short. Of stderr, the last line, which the chip shows when a run fails.
- **Paused while nobody looks.** Only the open sidebar counts as looking: its reads, on the board's poll, keep the widgets running. 15s after the sidebar shuts, or the last page showing it goes, scheduled runs stop. Nothing runs in the background for a sidebar nobody has open.
- **Opening the sidebar runs them all**, and so does `Ctrl+R` (the `refresh` key action) while the sidebar is out, bar a widget that is running or whose last run ended in the last 5s. With the sidebar shut, `Ctrl+R` runs none. A chip's own refresh, in its top-right corner and in its popover, runs that one widget now. A refresh serve refuses (the widget has gone from the file, or its machine cannot be reached) is said in the popover and to a screen reader, and the chip reads again at once.
- **An edit to the file.** A new widget runs at once. One whose command, format, templates, interval or timeout changed starts again and runs as soon as its old run's process has gone. A refresh asked right after the edit is that run, not one more. A new label or `lines` is only shown. A widget removed from the file is stopped, its process ended and its cached run deleted.
- **A file that is missing or cannot be read** shows no widgets: none for a missing file, one quiet problem for a broken one. Either way every widget stops, but no cached run is deleted, so a typo saved and fixed, an editor that saves by renaming the old file away, or a link to a volume not mounted yet brings each chip back with its last output.
- **After a restart** each chip shows its widget's last good output at once, rather than nothing, until its first run lands. Serve keeps it in `~/.local/state/operator-inbox/widgets/<id>.json` (under `$XDG_STATE_HOME`), a cache it writes after each good run and deletes with the widget. Runs are never events on the log, so nothing of them is replayed or exported (ADR-0007).

## What a command sees

Each run gets serve's own environment, with:

| Variable | Value |
| :-- | :-- |
| `PATH` | The file's `path` folders, then serve's own `PATH`. |
| `FORCE_COLOR`, `CLICOLOR_FORCE` | `1`, so a tool writing to a pipe keeps its colour. |
| `COLUMNS` | `40`, about the sidebar's width. |
| `OPERATOR_INBOX_WIDGET` | The widget's id, so one script can serve several widgets. |

It runs in the home folder, with no stdin. Under the launch agent, serve's environment is the plist's, not your shell's: its `PATH`, and no variable your shell profile sets.

## Other machines

Each **Inbox machine** runs its own widgets, from its own `widgets.json`, with its own tools. This machine's serve reads them through the machine's tunnel, as it reads the machine's Inboxes, and shows them in that machine's fold. A refresh is sent on to the machine by the widget's id alone. A machine's widgets run only while some page is looking at them; opening the sidebar runs every machine's.

A machine that cannot be reached keeps its last output, greyed and marked stale, with its refresh turned off until it answers again. A machine whose serve is older than widgets shows none.

## The chip

| State | Line one | The output |
| :-- | :-- | :-- |
| Waiting: the first run is going | `running…` | Blank. |
| Fresh | The output's age: `4s`, `5m`, `2h 3m` | The output, muted; the widget's tone is the strip along the top, and a line's own ANSI colours still show. |
| Running: a later run is going | `running…` | The last output; the strip pulses and the refresh spins. |
| Stale: the output is older than twice the interval plus the timeout | `stale · 5m` | The last output, faded. |
| Failed: the last run failed | `failed` | What failed: `exit 2: <the last line of stderr>`, `timed out after 10s`, `command not found`, `could not start: …`, `template: no value at used`. The popover keeps the last good output under it. |

The strip along the chip's top is in the output's tone, red on a failure and grey with no tone. A chip is a button: a screen reader hears its label, its output and any state its colour alone shows (`warning`, `problem`, `stale, 3m old`, `last run failed: …`). The pulse and the spin run only when the system does not ask for reduced motion.

## Who can see a widget

A widget's output is shown to every page that reaches serve: this machine's, and every tailnet peer `serve.tailnet.allowFrom` names in `config.json`, who can also run it now. **A command that prints a secret should not be a widget.**

The API never takes a command. A page, or a peer, can only ask serve to run a widget the file already names, by its id; what runs is always the command in that machine's own `widgets.json`.

## Checking a file

```sh
operator-inbox widgets
```

reads `widgets.json` as serve does and prints the file's path, its `path`, each widget that will run (its id, label, interval, timeout, format, lines and command, and `templated` when it maps its JSON through templates), then each problem, marked `dropped` or `ignored`. It runs nothing. With no file it says so, and how to start one; a file that does not decode exits non-zero with the one sentence saying why. `--json` prints the same as JSON.

```sh
operator-inbox doctor
```

has a `widgets` row. It decodes the file, lists its problems, and looks for each widget's command on the `PATH` serve would run it with (the launch agent's, from its plist, or this shell's when there is no plist), with the file's `path` in front. Only the command's first word is looked for: it is not checked (and said so) when it is bash's own (`echo`, `if`, `for`), a variable assignment, or something bash expands first (quotes, `$`, a glob). No file is fine. Anything else wrong is a warn, never a fail: a widget is optional, and costs only itself.
