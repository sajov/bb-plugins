---
name: listen
description: Use when working with offline speech in BB — transcribing an audio file, synthesizing speech, installing recognition models or voices, or diagnosing why the composer's microphone or reading answers aloud does not work.
---

# Listen — offline speech

Speech recognition and synthesis on this machine, with no cloud service and no
API key. Recognition answers BB's own microphone; synthesis reads finished
answers aloud.

## Check the state first

```sh
bb listen status
```

Reports the runtime, whether `ffmpeg` and `node` are present, the language,
which models are ready, and — the line people miss — which service BB's voice
task is set to. The composer's microphone only reaches this plugin when that is
`listen/listen` (`bb settings ai-services set voice listen`).

## Commands

| Command | Use |
| --- | --- |
| `bb listen transcribe <file> [model]` | Transcribe an audio file. WAV needs nothing; other formats need ffmpeg. |
| `bb listen speak <text> [--voice <id>]` | Synthesize to a WAV and print the path. |
| `bb listen condense <text>` | Run the configured summarizer, to try a prompt or model. |
| `bb listen download <model-id>` / `delete` | Manage recognition models. |
| `bb listen voices` / `voice-download <id>` / `voice-delete <id>` | Manage voices. |
| `bb listen install-runtime` | Install the native runtime (about 33 MB). |

Downloads return immediately and continue in the background — poll
`bb listen status`, do not wait on the command.

## Settings

`bb plugin config listen` lists them; `bb plugin config listen set <key>
<value>` changes one. Keys: `language`, `model`, `summarize`,
`summaryBackend`, `summaryThreadModel`, `summaryThreadProvider`,
`summaryApiUrl`, `summaryApiModel`, `summaryApiKey`, `summaryPrompt`,
`voiceModel`, `voiceSid`, `voiceSpeed`.

`summaryBackend` is `thread` (a hidden BB thread, no setup, ~8s and real
tokens) or `api` (any OpenAI-compatible `/chat/completions` endpoint — Ollama,
LM Studio, vLLM, a company proxy — under a second with a small local model).
`gemma3:4b` is the measured pick; 3B models are fast but invent things, and
reasoning models such as Gemma 4 spend the whole budget thinking and return
nothing. The thread route's model and
the API route's model are separate settings on purpose. A failure on either
path falls back to speaking the filtered original answer and logs why.

`bb listen condense <text>` runs the configured summarizer on a text, which is
how to test a prompt or model without ending a real turn.

`summaryPrompt` is what the hidden summary thread is told before the answer;
empty means the built-in prompt. There is no global switch for reading aloud:
every thread starts silent, and the speaker button beside the composer's
microphone turns it on for that thread only.

Settings are read when the plugin loads, so run `bb plugin reload listen`
after changing one.

## When something does not work

- **The microphone produces nothing.** BB's voice task is not set to Listen
  (`bb settings ai-services set voice listen`), or the model in the plugin's
  settings is not downloaded. `bb listen status` shows both.
- **"needs ffmpeg".** BB records compressed audio. Install ffmpeg.
- **Speaking fails, recognition works.** Node is not on PATH. Synthesis runs in
  a separate `node` process because BB's Electron binary rejects the audio
  buffers the engine returns.
- **"only speaks de-DE".** The voice and the `language` setting disagree. Change
  one of them; the plugin will not mangle text through the wrong phoneme set.
- **Nothing is read aloud.** This thread's speaker button is off — every
  thread starts that way — or the answer was empty, or the answer was nothing
  but code — a code block reduces to no speakable words and is skipped rather
  than read as "code block omitted".

## Constraints worth knowing

- Recognition is batch, not streaming: text appears after the recording stops.
- BB's transcription call carries no language; the `language` setting is the
  only source. Parakeet and Moonshine detect it themselves and ignore it.
- Models are large (43 MB to 1.8 GB) and live in the plugin's data directory.
  An existing pi-listen install is read from in place rather than duplicated.
