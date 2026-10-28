# Voice dictation

`corgi voice` turns speech into typing. It listens on the machine with the
microphone, transcribes with a local Whisper model, and types what you said
into the focused pane of the viewer you used last. It never presses Enter for
you, and what you say is typed as text, without filler words.

Audio stays on your machine. Only the transcribed text and the mute state
reach the runtime, locally or over SSH.

## Set up

Voice mode needs `whisper-server` and `ffmpeg`, a speech model and a speech filter.

| Platform | Install |
| --- | --- |
| macOS | `brew install whisper-cpp ffmpeg` |
| Arch | `sudo pacman -S whisper-cpp ffmpeg` |
| Debian, Ubuntu | `sudo apt install whisper.cpp-tools ffmpeg` |
| Other Linux | ffmpeg from your package manager; build whisper.cpp with CMake for `build/bin/whisper-server` |

Then run:

```sh
corgi voice setup
```

Setup checks `whisper-server` and `ffmpeg`, then downloads the `base.en`
model and the Silero speech filter into `~/.cache/corgi/voice/`. Each file is
checked against a pinned size and SHA-256 before it is kept. A second run
downloads nothing. Exit status is 0 when voice is ready and 1 otherwise.

`corgi voice setup --model NAME` fetches another model:

| Model | Size | Notes |
| --- | --- | --- |
| `tiny.en` | 78 MB | Fastest, least accurate |
| `base.en` | 148 MB | Default |
| `small.en` | 488 MB | More accurate, slower |
| `medium` | 1.5 GB | Multilingual: detects the language you speak |
| `large-v3-turbo` | 1.6 GB | Multilingual, most accurate |

The speech filter needs a `whisper-server` whose `--help` lists `--vad`.
Setup reports an older one as too old: update whisper.cpp, or run voice mode
with `--no-filter`.

## Dictate

Start Corgi, then run `corgi voice` in another terminal, or in a Corgi pane.
The screen is a small table:

| Field | Shows |
| --- | --- |
| `Target` | `local` or the SSH host, and the title of the pane your text goes to, as `local → dictation` |
| `Device` | The microphone; `(default)` for the system default |
| `Level` | A braille meter in the theme's colors, dimmed while your voice is under the threshold (the bar, `T:`), and grey while muted. A thin grey line grows under it while you pause; when it reaches the end, the utterance ends |
| `Model` | The Whisper model |
| `Mode` | `Listening`, or `MUTED` in red (also while voice cannot listen, as in the sidebar) |
| `Options` | What ends an utterance (`silence`, `burst`), the speech `filter`, and what starts one (`pre-roll`, `min speech`) |

Click an option to change it: a menu opens with a few values to pick with a
click, or with `↑`/`↓` and Enter (Esc closes it). A click on `filter` switches
it.

The note before the title adds what speech is doing: `♫` in a slightly
different green while listening, recording or transcribing, and a grey `♪`
when muted. Click it, or the mode, to mute or unmute. Without a viewer there
is nowhere to type, so voice mode holds off until one attaches, and says so
at the top of the history.

The history lists each utterance with the time you said it and, once typed,
how long the text took after you stopped speaking, as in
`✓ 14:02:31 (156ms) text`. A `✗` row says why text was not typed; one that
got no answer in time may still have been typed. What you say while muted, or
what muting cuts off, leaves no row.

An utterance ends after 2.5 seconds of silence and is capped at 30 seconds.
Short peaks under 0.1 seconds, such as music below your voice, don't keep it
open. An utterance that follows another in the same pane is joined to it with
one space; after anything else you type, it starts fresh.
Filler words (um, uh, hmm, ah, er) are removed from the text. Non-speech
markers such as `[BLANK_AUDIO]`, and lines Whisper invents from silence
("Thank you."), are not typed at all.

If voice mode runs in a Corgi pane and that pane has focus, nothing is typed:
the history says "focused pane is the voice pane".

| Key | Does |
| --- | --- |
| `m` | Mute or unmute |
| `?` | Explain the options and how each changes what becomes text |
| `+` / `-` | Raise or lower the threshold by 2 (or turn the mouse wheel anywhere in the window) |
| `f` | Turn the speech filter on or off; restarts whisper-server, about a second, and brings it back after a crash |
| `d` | Pick another microphone |
| `j` / `k`, `↓` / `↑` | Scroll the history by a row |
| `Ctrl+D` / `Ctrl+U` | Scroll by half a page |
| `Ctrl+F` / `Ctrl+B`, `PgDn` / `PgUp` | Scroll by a page |
| `g` / `G` | Oldest / newest |
| `q`, `Ctrl+C` | Quit; stops ffmpeg and whisper-server |

Threshold, option and filter changes last for the session. Put values you
like in `voice.json`. The line under the level grows while you pause, so you can
see when the utterance is about to end. `Target:` follows the focused pane as you move around in Corgi. The footer lists as many keys as fit.

## Mute

Voice mode and Corgi share one mute state. Press `m` in voice mode, or
**prefix M** in Corgi (every preset). **prefix m** still mutes sounds. The
sidebar's title row shows `♫` while voice listens and a faint `♪` while it is
muted; click it to toggle. Beside the corgi badge the title shortens to make
room; with no voice attached it is gone. `corgi action voice-mute` does the same from a script.

Muting drops anything not yet typed. When the microphone or Whisper fails,
the indicator shows muted and unmuting has no effect until it recovers.

## Remote runtimes

```sh
corgi voice --ssh devbox
```

Voice mode runs here, with your microphone and model, and starts
`corgi __voice-bridge` on the host through `ssh -T`. Host key and password
prompts come before the screen takes over; reconnects use `BatchMode`, so set up
key authentication for unattended use. The host needs a Corgi with voice
support and a running runtime. Your local `voice.json` applies; a `voice.json`
on the host is ignored.

If the link drops, what you say meanwhile fails as "not connected" and is
never typed later. Voice mode reconnects every 5 seconds and restores its mute
state.

## Settings

`~/.local/state/corgi/voice.json` (or under `$XDG_STATE_HOME`) on the machine
running voice mode. Every field is optional.

```json
{
  "threshold": 44,
  "silence": 2.5,
  "pre_roll": 0.3,
  "min_speech": 0.2,
  "burst": 0.1,
  "model": "base.en",
  "speech_filter": true,
  "device": null
}
```

| Field | Default | Flag |
| --- | --- | --- |
| `threshold` | 44, on a 0 to 100 scale | `--threshold N` |
| `silence` | 2.5 seconds, 0.5 to 10 | `--silence SECONDS` |
| `pre_roll` | 0.3 seconds, 0 to 2: audio kept from before you start | |
| `min_speech` | 0.2 seconds, 0.02 to 2: shorter sounds are dropped | |
| `burst` | 0.1 seconds, 0.02 to 1: shorter peaks don't keep an utterance open | |
| `model` | `base.en` | `--model NAME` |
| `port` | a free port each run, for whisper-server on 127.0.0.1 | `--port PORT` |
| `speech_filter` | `true` | `--no-filter` |
| `device` | system default | `--device ID` |

A bad field falls back to its default, and voice mode shows a notice naming
it. Flags apply to one run. whisper-server answers anything on its port
without authentication, so leave `port` unset unless you need a fixed one.

`--verbose` appends one line per utterance (duration, transcription and
delivery times, outcome) and whisper-server's health to `voice.log` beside
`voice.json`. Nothing goes to the screen.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Microphone access denied" | macOS: allow your terminal app in System Settings › Privacy & Security › Microphone, then restart the terminal |
| "The microphone is in use by another program" | Close the other program; voice mode retries every 5 seconds |
| "No microphone found" | Press `d` and pick one, or check `--device` |
| "port N is in use" | Set another `port` in `voice.json`, pass `--port`, or leave it unset |
| "The speech filter is not installed" | Run `corgi voice setup`; without it, noise can turn into text |
| "this Corgi daemon has no voice support" | `corgi reload` to replace the daemon |
| "Corgi on HOST has no voice support" | Install a Corgi with voice support on the host |
| "The Whisper server stopped" | Press `f` for a fresh one (it switches the filter), or quit and start voice mode again |
| Background noise becomes text | Raise the threshold with `+`, or keep the speech filter on |
| Quiet speech is missed | Lower the threshold with `-` until the meter crosses the marker as you speak |
