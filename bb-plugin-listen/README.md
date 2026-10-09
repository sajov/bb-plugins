# Listen

Speech in and speech out for BB, running entirely on your own machine with
open models. Nothing is sent to a cloud service, and there is no API key.

Ported from [pi-listen](https://github.com/codexstar69/pi-listen) (MIT), whose
model catalogs, download logic, sherpa-onnx engines and speech text filter do
the heavy lifting here. Its terminal UI was not ported; BB's own surfaces
replace it.

> **macOS first.** Developed and tested on macOS (Apple Silicon) only. Linux
> should work but has not been tried; Windows has not been tried either and is
> the least likely to work as-is. See [Requirements](#requirements) before you
> start.

## What it does

**Speech to text.** BB hands its transcription over to a plugin, so the
microphone already in the composer is the whole interface: press it, speak,
and the words land in the prompt. Nineteen recognition models are available,
from a 43 MB one that runs on a Raspberry Pi to Whisper Large.

**Text to speech.** When a turn finishes, the answer can be read aloud. An LLM
answer is not speakable material — headings, code fences, file paths — so by
default the answer first goes through a hidden thread that condenses it to two
or three plain sentences, and *that* is what you hear.

## Requirements

**Platforms.**

| Platform | Status |
| --- | --- |
| macOS, Apple Silicon | developed and tested here |
| macOS, Intel | not tried |
| Linux (glibc, 64-bit) | should work — same tools, same paths — but not tried |
| Linux on Alpine (musl) or 32-bit ARM | not supported: no sherpa-onnx build; the setup page says so |
| Windows | not tried and least likely to work: voice archives are unpacked with `tar -xj`, and the error hints assume Homebrew |

**Tools on the machine.** The plugin calls these, it does not bring them:

| | Needed for | If missing |
| --- | --- | --- |
| `ffmpeg` | decoding BB's recordings | transcription fails with a message naming it |
| `node` | speaking | speaking fails; recognition still works |
| `npm` | installing the runtime once | the setup page's install button fails |
| `tar` (with bzip2) | unpacking a voice | voice installs fail |

On macOS with [Homebrew](https://brew.sh):

```sh
brew install ffmpeg node   # node brings npm; tar is part of macOS
```

On Debian/Ubuntu: `sudo apt install ffmpeg nodejs npm bzip2`.

BB's daemon may not see your shell's `PATH`. For `node` the plugin also checks
`/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`. The setup page shows
which tools it found, so a missing one is visible before it bites.

## Setup

Open the plugin's settings page in BB and work down it:

1. **Install the speech runtime** — about 33 MB of sherpa-onnx, fetched once
   per machine. If you already run pi-listen, its copy is used instead.
2. **Download a recognition model** — `parakeet-v3` handles 25 languages and
   is the default. The list shows size, languages and ratings.
3. **Point BB at the plugin** — pick *Listen* for voice input in Settings →
   AI services, or run:

   ```sh
   bb settings ai-services set voice listen
   ```

   `bb settings ai-services show` confirms it. The model is the one chosen in
   the plugin's settings.

4. **For speaking**, install a voice in the same page. Match the voice to
   your language — a German voice refuses English text rather than mangling
   it.

## Speaking, per thread

Beside BB's microphone sits a speaker button. It switches reading aloud on or
off **for that thread only**. Every thread starts silent — it works like a
monitor: you switch on the one conversation you want to follow by ear, instead
of hearing every thread you forgot to mute. The button appears once a voice is
installed; it is not on the new-thread composer, since there is nothing to
switch yet.

The *Condensing prompt* setting is what the summarizer is told. The answer is
appended below it. Rewrite it to taste — ask for one sentence, ask it to always
name the file that changed, ask it to be blunt. Leave it empty for the built-in
prompt.

### Who does the condensing

*Condense with* picks between two summarizers:

- **thread** (default) — a hidden BB thread running an agent you already have.
  Nothing to install. Measured on an M-series machine: about 8 seconds per
  answer, and it spends real tokens. `summaryThreadModel` and
  `summaryThreadProvider` point it at a cheaper model; that saves money but
  barely any time, because most of it goes into starting the agent, not into
  the model.
- **api** — any OpenAI-compatible `/chat/completions` endpoint. That covers
  Ollama, LM Studio, llama.cpp's server, vLLM, Groq, OpenRouter and most
  company proxies, so it is not tied to having Ollama on your laptop. Set
  *API address*, *Condensing model (API route)* and, if the endpoint wants
  one, *API key*.

#### Which model

Measured against two real German answers, warm, through the plugin:

| Model | Time | Result |
| --- | --- | --- |
| `gemma3:4b` | 0.4 s | correct, and the only one that reliably keeps to the length asked for |
| `qwen2.5:3b` | 0.3–0.8 s | correct, but drifts towards restating the answer |
| `llama3.2` (3B) | 0.7 s | right once, invented connections the other time |
| `qwen3:8b` | 5.6 s | best content, barely faster than the thread route |
| `gemma4:12b` | 30 s | fails — a reasoning model, see below |

`gemma3:4b` is the default for that reason. Note that the smallest models are
not the safe choice: 3B models summarize fluently and get facts wrong, which
is worse than a slow summary.

Reasoning models need room. They spend the answer budget on thinking, so the
limit here is 1200 tokens rather than the few hundred two sentences need; when
one still returns nothing, the error says so instead of blaming an "empty
summary". Gemma 4 thinks by default and is a poor fit for this job.

A `<think>…</think>` preamble is stripped before anything is spoken, and the
summary itself goes through the speech filter — small models return
`settings.onChange` in backticks however plainly you ask them not to.

Either way a failure is not fatal — the filtered original answer gets spoken
instead, and the reason lands in the plugin log. To try a prompt or a model
without ending a real turn:

```sh
bb listen condense "some long answer text"
```

### Why Node

Node is needed because BB's own binary is Electron, and Electron's V8 refuses
the externally-backed audio buffers sherpa returns. Synthesis therefore runs in
a separate `node` process, which stays alive between answers and keeps its
loaded voice — the first answer after a pause takes about half a second, the
ones after it a tenth. The process stops itself after five idle minutes.
Recognition is unaffected: it returns a string, not a buffer.

### German voices

The catalog carries eight, all Piper. `thorsten_emotional-medium` is the pick:
warmer than plain Thorsten and, measured on an M-series machine, three times
quicker than it. `thorsten-high` is the clearest and the slowest. The `-int8`
entries are quantized — a smaller download, but slower here, not faster.
Piper is the ceiling for German under sherpa-onnx; Kokoro, the best-sounding
model in the catalog, does not speak German at all.

## Commands

```sh
bb listen status                      # runtime, models, what BB is pointed at
bb listen install-runtime             # install the native runtime
bb listen download <model-id>         # download a recognition model
bb listen delete <model-id>
bb listen transcribe <file> [model]   # the microphone path, without a microphone
bb listen voices                      # installed voices
bb listen voice-download <id>
bb listen voice-delete <id>
bb listen speak <text> [--voice <id>] # synthesize to a WAV and print its path
bb listen condense <text>             # run the configured summarizer on a text
```

`transcribe` and `speak` are the diagnostic pair: if `bb listen speak` produces
a file and `bb listen transcribe` reads it back, both halves work.

## Settings

`language`, `model`, `summarize`, `summaryBackend`,
`summaryThreadModel`, `summaryThreadProvider`, `summaryApiUrl`,
`summaryApiModel`, `summaryApiKey`, `summaryPrompt`, `voiceModel`,
`voiceSid`, `voiceSpeed` — set them in BB's settings UI or with
`bb plugin config listen set <key> <value>`. Settings are read at load, so the
plugin reloads itself after a change.

`language` matters more than it looks. BB's transcription call carries no
language, so this setting is the only way the recognizer learns one — and the
speech filter uses it too: spelling numbers out and expanding abbreviations
produce English words, so those run for English only. A German summary ending
in "49 Tests" was spoken as "forty-nine Tests" until the language reached the
filter.

## How it is put together

| File | Runs where | Owns |
| --- | --- | --- |
| `host.ts`, `host/` | the daemon's host worker | the native runtime, models, recognition, synthesis |
| `server.ts` | BB's server | service registration, RPC, the CLI, the speaking pipeline |
| `app.tsx` | the app | the settings page and the playback badge |
| `lib/speech/` | both | text filtering and the speaking decisions |

The split is not decoration: a BB server bundle cannot carry a native addon,
and managed Git installs run `npm install --omit=optional`, which is exactly
where sherpa's per-platform prebuilds live. The host worker has a persistent
data directory and can install and load one at runtime.

## Not included

Deepgram (pi-listen's cloud backend), dictation mode, transcription history,
and streaming transcription. Local models work in batches: the text appears
after you stop speaking, as it does in pi-listen.
