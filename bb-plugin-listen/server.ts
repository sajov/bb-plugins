/**
 * Listen — offline speech for BB.
 *
 * The server entry is deliberately thin. It registers the plugin as BB's
 * transcription service, forwards the settings page to the host worker that
 * owns the models, and keeps the host's copy of the language setting current.
 * Nothing native and nothing large lives here.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  hostContract,
  hostSignals,
  modelStateSchema,
  setupStateSchema,
  hostConfigSchema,
  voiceStateSchema,
} from "./contract.js";
import { shouldSpeak, speaksAloud, spokenText } from "./lib/speech/decide.js";
import { condenseWithApi, CondenseApiError } from "./lib/speech/condense-api.js";
import { previewText } from "./lib/speech/preview-text.js";
import { isSelectedForVoice, selectCommand, transcriptOrThrow } from "./lib/ai-service.js";

/** The AI-service id BB's voice selection names (`bb settings ai-services set voice listen`). */
export const SERVICE_ID = "listen";

/** Realtime channel the settings page refetches on. */
const CHANGED = "listen-changed";

/** Realtime channel that tells the app a clip is ready to play. */
const SPEAK = "listen-speak";

/**
 * What the hidden thread is told, unless the user replaced it.
 *
 * A setting rather than a constant because what makes a good spoken summary
 * is a matter of taste and of what you work on: someone reviewing prose wants
 * different emphasis than someone watching a refactor.
 */
export const DEFAULT_SUMMARY_PROMPT = [
  "Summarize the assistant message below for text-to-speech.",
  "",
  "Rules:",
  "- Two or three sentences, no more.",
  "- Plain spoken prose: no markdown, no lists, no code, no headings, no URLs.",
  "- Say what was done or found and what it means. Skip file names, commands and numbers unless they are the point.",
  "- Answer with the summary alone, nothing else.",
  "",
  "Message:",
].join("\n");

/**
 * What the composer's speaker button renders from. `available` is false while
 * speaking is not set up — no runtime, no Node, or the chosen voice not
 * installed — and the button then stays hidden rather than offering a switch
 * that would do nothing.
 */
const speechChoiceSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
});

export const rpcContract = defineRpcContract({
  state: {
    input: z.null(),
    output: z.object({
      setup: setupStateSchema,
      sttModels: z.array(modelStateSchema),
      voices: z.array(voiceStateSchema),
      config: hostConfigSchema,
      summarize: z.boolean(),
      /** The command that points BB's voice input here, assembled for copying. */
      transcriptionSetting: z.string(),
      /** Whether BB's voice task is pinned to this plugin. */
      active: z.boolean(),
    }),
  },
  installRuntime: { input: z.null(), output: z.object({ started: z.boolean() }) },
  downloadModel: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ started: z.boolean() }),
  },
  cancelDownload: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ cancelled: z.boolean() }),
  },
  deleteModel: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ deleted: z.boolean() }),
  },
  downloadVoice: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ started: z.boolean() }),
  },
  cancelVoiceDownload: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ cancelled: z.boolean() }),
  },
  deleteVoice: {
    input: z.object({ modelId: z.string() }),
    output: z.object({ deleted: z.boolean() }),
  },
  /** Speak a sample, for the settings page's preview button. */
  preview: {
    input: z.object({ modelId: z.string(), sid: z.number() }),
    output: z.object({ wavBase64: z.string() }),
  },
  /**
   * Collect the clip a `listen-speak` signal announced. Returns null when
   * another window already took it, which is how only one of them speaks.
   */
  takeSpeech: {
    input: z.object({ id: z.string() }),
    output: z
      .object({
        wavBase64: z.string(),
        text: z.string(),
        threadId: z.string(),
        threadTitle: z.string().nullable(),
      })
      .nullable(),
  },

  /** Threads that chose to speak with the composer button. */
  speakingThreads: {
    input: z.null(),
    output: z.object({ threadIds: z.array(z.string()) }),
  },

  /** Whether this thread speaks, for the composer button to render from. */
  threadSpeech: {
    input: z.object({ threadId: z.string() }),
    output: speechChoiceSchema,
  },

  /** `enabled: null` drops the thread's choice; every thread starts silent. */
  setThreadSpeech: {
    input: z.object({ threadId: z.string(), enabled: z.boolean().nullable() }),
    output: speechChoiceSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {

  const settings = bb.settings.define({
    language: {
      type: "string",
      label: "Spoken language",
      description:
        "BCP-47 tag such as de or en-GB. Models that detect the language themselves ignore it.",
      default: "en",
    },
    model: {
      type: "string",
      label: "Recognition model",
      description:
        "The model id BB's microphone transcribes with.",
      default: "parakeet-v3",
    },
    summarize: {
      type: "boolean",
      label: "Condense before speaking",
      description:
        "Send the answer through a hidden thread first and speak two or three plain sentences instead of the full reply.",
      default: true,
    },
    summaryBackend: {
      type: "select",
      label: "Condense with",
      description:
        "A hidden BB thread needs no setup and uses a model you already pay for. An API is any OpenAI-compatible endpoint — Ollama, LM Studio, llama.cpp, vLLM, a company proxy — and is usually faster and cheaper.",
      options: ["thread", "api"],
      default: "thread",
    },
    summaryThreadModel: {
      type: "string",
      label: "Condensing model (thread route)",
      description:
        "A BB model id for the hidden thread — a small, cheap one is plenty. Empty uses the project default.",
      default: "",
    },
    summaryThreadProvider: {
      type: "string",
      label: "Condensing provider (thread route)",
      description: "The BB provider that owns the model above. Empty uses the project default.",
      default: "",
    },
    summaryApiModel: {
      type: "string",
      label: "Condensing model (API route)",
      description:
        "The model name the endpoint knows. Kept separate from the thread route's model so switching routes cannot send one a name meant for the other.",
      default: "gemma3:4b",
    },
    summaryApiUrl: {
      type: "string",
      label: "API address",
      description:
        "API route only. Include the version path. Ollama: http://127.0.0.1:11434/v1 — LM Studio: http://127.0.0.1:1234/v1",
      default: "http://127.0.0.1:11434/v1",
    },
    summaryApiKey: {
      type: "string",
      label: "API key",
      secret: true,
      description: "API route only. Leave empty for local servers, which need none.",
    },
    summaryPrompt: {
      type: "string",
      label: "Condensing prompt",
      experimental_multiline: true,
      description:
        "What the hidden thread is told. The answer is appended below it. Leave empty to use the built-in prompt.",
      default: DEFAULT_SUMMARY_PROMPT,
    },
    voiceModel: {
      type: "string",
      label: "Voice",
      description: "Voice model id, e.g. piper-de_DE-thorsten-medium-int8.",
      default: "kitten-nano-en-v0_2",
    },
    voiceSid: {
      type: "number",
      label: "Voice number",
      description: "Which speaker inside the voice model to use.",
      default: 0,
    },
    voiceSpeed: {
      type: "number",
      label: "Speaking rate",
      description: "1 is the model's natural pace; 1.2 is noticeably brisker.",
      default: 1,
    },
  });

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  // Every host signal is an invalidation: the page refetches rather than
  // trusting a payload, so a missed signal costs a stale second, not a lie.
  const unsubscribe = host.experimental_onSignal("changed", () => {
    bb.realtime.publish(CHANGED, {});
  });

  /**
   * The host runs on the primary host — the same one core calls for
   * transcription. Resolved per call rather than cached: hosts can be
   * re-enrolled while the plugin is loaded.
   */
  async function hostId(): Promise<string> {
    const config = await bb.sdk.system.config();
    const id = config.primaryHostId;
    if (id === null) {
      throw new Error("BB has no primary host, so the speech runtime has nowhere to run.");
    }
    return id;
  }

  async function callHost<Method extends keyof typeof hostContract>(
    method: Method,
    input: Parameters<typeof host.call<Method>>[1],
  ) {
    return host.call(method, input, { hostId: await hostId() });
  }

  // BB offers a service for voice input when it declares `transcribe`; the
  // recording is decoded and recognised on the host, where the native runtime
  // and the models live. Speaking aloud is not an AI-service task — BB has no
  // such slot — so it stays the plugin's own feature.
  bb.experimental_aiServices.register({
    id: SERVICE_ID,
    displayName: "Listen (offline speech)",
    transcribe: async (audio, { signal }) => {
      const { model } = await settings.get();
      const result = await host.call(
        "transcribeAudio",
        {
          audioBase64: Buffer.from(await audio.arrayBuffer()).toString("base64"),
          mimeType: audio.type || "audio/webm",
          modelId: model,
        },
        { hostId: await hostId(), signal },
      );
      return transcriptOrThrow(result);
    },
  });

  /** Push what the host cannot be told per call. */
  async function pushConfig(): Promise<void> {
    const values = await settings.get();
    await callHost("setConfig", {
      language: values.language,
      voiceModel: values.voiceModel,
      voiceSid: values.voiceSid,
      voiceSpeed: values.voiceSpeed,
    });
  }

  /**
   * A project id for the diagnostic condense command.
   *
   * The thread route has to spawn its worker somewhere, and a command line
   * has no thread to inherit from. Any project does — the worker is hidden,
   * archived and stopped straight after.
   */
  async function currentProjectId(): Promise<string> {
    const projects = await bb.sdk.projects.list();
    const first = projects[0];
    if (first === undefined) {
      throw new Error("There is no project to run the condensing thread in.");
    }
    return first.id;
  }

  /** The answer both the composer button and the settings page render. */
  async function describeThreadSpeech(
    threadId: string,
  ): Promise<z.infer<typeof speechChoiceSchema>> {
    const override = await readThreadSpeech(threadId);
    return {
      // Every thread starts silent; only its own button turns speaking on.
      enabled: speaksAloud({ enabled: false, override }),
      available: await speechAvailable(),
    };
  }

  /**
   * Whether an answer could be spoken right now. A host that cannot be
   * reached counts as not set up: the button would fail either way.
   */
  async function speechAvailable(): Promise<boolean> {
    try {
      const [{ setup, voices }, { voiceModel }] = await Promise.all([
        callHost("state", null),
        settings.get(),
      ]);
      return (
        setup.runtime.installed &&
        setup.node !== null &&
        voices.some((voice) => voice.id === voiceModel && voice.installed)
      );
    } catch {
      return false;
    }
  }

  // ─── Reading answers aloud ────────────────────────────────────────────────

  /**
   * The last spoken clip, waiting to be collected.
   *
   * Audio does not travel on the realtime channel: that is an app-wide
   * broadcast, and a WAV is not a notification. The signal carries an id and
   * the browser fetches the bytes over RPC — so a second window that also
   * hears the signal collects nothing and stays quiet.
   */
  let pending: {
    id: string;
    wavBase64: string;
    text: string;
    threadId: string;
    threadTitle: string | null;
  } | null = null;

  /** Hidden threads we started, so their own idle events do not loop back. */
  const ourWorkers = new Set<string>();

  /**
   * Per-thread speaking choices, from the speaker button in each composer.
   *
   * Kept in plugin storage rather than on the thread: this SDK version has no
   * thread plugin-metadata API. A thread missing from the map has made no
   * choice and follows the setting — which is why the value is a tri-state
   * and not a boolean with a default.
   */
  const THREAD_SPEECH_KEY = "thread-speech";

  async function readAllThreadSpeech(): Promise<Record<string, boolean>> {
    return (await bb.storage.kv.get<Record<string, boolean>>(THREAD_SPEECH_KEY)) ?? {};
  }

  async function readThreadSpeech(threadId: string): Promise<boolean | null> {
    return (await readAllThreadSpeech())[threadId] ?? null;
  }

  async function writeThreadSpeech(
    threadId: string,
    enabled: boolean | null,
  ): Promise<void> {
    const all = await readAllThreadSpeech();
    // Clearing removes the entry entirely, so the thread goes back to
    // following the setting instead of freezing today's value.
    if (enabled === null) delete all[threadId];
    else all[threadId] = enabled;
    await bb.storage.kv.set(THREAD_SPEECH_KEY, all);
  }

  /**
   * Condense an answer through a hidden thread.
   *
   * Returns null when the summary cannot be had — the caller then speaks the
   * filtered original rather than nothing, because silence reads as a broken
   * feature while a long answer merely reads as a long answer.
   */
  /**
   * Condense through whichever backend is configured.
   *
   * Both paths return null on failure and log why: the caller speaks the
   * filtered original instead, because silence reads as a broken feature.
   */
  async function condense(
    answer: string,
    source: { projectId: string; prompt: string },
  ): Promise<string | null> {
    const values = await settings.get();
    if (values.summaryBackend === "api") {
      if (values.summaryApiModel.trim() === "") {
        bb.log.warn(
          "condensing through an API needs a model name in the plugin's settings",
        );
        return null;
      }
      try {
        return await condenseWithApi(source.prompt, answer, {
          url: values.summaryApiUrl,
          model: values.summaryApiModel,
          apiKey: values.summaryApiKey,
        });
      } catch (cause) {
        bb.log.warn(
          `could not condense through the API: ${
            cause instanceof CondenseApiError ? cause.message : String(cause)
          }`,
        );
        return null;
      }
    }
    return condenseInThread(answer, {
      ...source,
      model: values.summaryThreadModel.trim(),
      providerId: values.summaryThreadProvider.trim(),
    });
  }

  async function condenseInThread(
    answer: string,
    source: { projectId: string; prompt: string; model: string; providerId: string },
  ): Promise<string | null> {
    let workerId: string | null = null;
    try {
      const worker = await bb.sdk.threads.spawn({
        projectId: source.projectId,
        environment: { type: "project-default" },
        prompt: `${source.prompt}\n${answer}`,
        title: "Listen: spoken summary",
        visibility: "hidden",
        // Omitted rather than passed empty: BB then resolves the project's
        // own defaults, which is what "no opinion" has to mean here.
        ...(source.model === "" ? {} : { model: source.model }),
        ...(source.providerId === "" ? {} : { providerId: source.providerId }),
        pluginMetadata: { purpose: "spoken-summary" },
      });
      workerId = worker.id;
      ourWorkers.add(worker.id);

      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
      const { output } = await bb.sdk.threads.output({ threadId: worker.id });
      const summary = output?.trim() ?? "";
      return summary === "" ? null : summary;
    } catch (cause) {
      bb.log.warn(`could not condense an answer for speech: ${String(cause)}`);
      return null;
    } finally {
      if (workerId !== null) {
        ourWorkers.delete(workerId);
        // A hidden worker holds an agent process until it is stopped.
        await bb.sdk.threads.archive({ threadId: workerId }).catch(() => {});
        await bb.sdk.threads.stop({ threadId: workerId }).catch(() => {});
      }
    }
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    void (async () => {
      const values = await settings.get();
      const decision = shouldSpeak(thread, {
        enabled: false,
        override: await readThreadSpeech(thread.id),
        lastAssistantText,
        ourWorkers,
      });
      if (!decision.speak) return;
      // `shouldSpeak` already established the answer is there.
      const answer = lastAssistantText as string;

      try {
        const summary = values.summarize
          ? await condense(answer, {
              projectId: thread.projectId,
              prompt:
                values.summaryPrompt.trim() === ""
                  ? DEFAULT_SUMMARY_PROMPT
                  : values.summaryPrompt,
            })
          : null;
        const spoken = spokenText(summary, answer, values.language);
        if (spoken === null) return;

        const audio = await callHost("speak", {
          text: spoken.text,
          modelId: null,
          sid: null,
        });
        pending = {
          id: randomUUID(),
          wavBase64: audio.wavBase64,
          text: spoken.text,
          threadId: thread.id,
          threadTitle: thread.title ?? null,
        };
        bb.realtime.publish(SPEAK, { id: pending.id, threadId: thread.id });
      } catch (cause) {
        bb.log.warn(`could not speak an answer: ${String(cause)}`);
      }
    })();
  });

  bb.rpc.register(rpcContract, {
    state: async () => {
      const [state, config, values] = await Promise.all([
        callHost("state", null),
        bb.sdk.system.aiServices(),
        settings.get(),
      ]);
      return {
        ...state,
        transcriptionSetting: selectCommand(SERVICE_ID),
        active: isSelectedForVoice(config.selections.voice, bb.pluginId, SERVICE_ID),
        summarize: values.summarize,
      };
    },
    installRuntime: async () => callHost("installRuntime", null),
    downloadModel: async ({ modelId }) => callHost("downloadModel", { modelId }),
    cancelDownload: async ({ modelId }) => callHost("cancelDownload", { modelId }),
    deleteModel: async ({ modelId }) => callHost("deleteModel", { modelId }),
    downloadVoice: async ({ modelId }) => callHost("downloadVoice", { modelId }),
    cancelVoiceDownload: async ({ modelId }) =>
      callHost("cancelVoiceDownload", { modelId }),
    deleteVoice: async ({ modelId }) => callHost("deleteVoice", { modelId }),
    preview: async ({ modelId, sid }) => {
      // The sample has to be in the voice's own language — see preview-text.ts.
      const { voices } = await callHost("state", null);
      const model = voices.find((voice) => voice.id === modelId);
      const audio = await callHost("speak", {
        text: previewText(model, sid),
        modelId,
        sid,
      });
      return { wavBase64: audio.wavBase64 };
    },
    threadSpeech: async ({ threadId }) => describeThreadSpeech(threadId),
    setThreadSpeech: async ({ threadId, enabled }) => {
      await writeThreadSpeech(threadId, enabled);
      // The settings page shows the same state; tell every open window.
      bb.realtime.publish(CHANGED, {});
      return describeThreadSpeech(threadId);
    },
    takeSpeech: ({ id }) => {
      if (pending === null || pending.id !== id) return null;
      const clip = pending;
      pending = null;
      return {
        wavBase64: clip.wavBase64,
        text: clip.text,
        threadId: clip.threadId,
        threadTitle: clip.threadTitle,
      };
    },
    speakingThreads: async () => {
      const all = await readAllThreadSpeech();
      return {
        threadIds: Object.keys(all).filter((threadId) => all[threadId] === true),
      };
    },
  });

  // The same operations as the settings page, for a terminal — and the only
  // way to reach them while BB's window is not open.
  const usage = [
    "Usage:",
    "  bb listen status            Runtime, models and what BB is pointed at",
    "  bb listen install-runtime   Install the native speech runtime",
    "  bb listen download <model>  Download a recognition model",
    "  bb listen delete <model>    Remove a downloaded model",
    "  bb listen transcribe <file> [model]  Transcribe an audio file",
    "  bb listen voices            List installed voices",
    "  bb listen voice-download <id>  Install a voice",
    "  bb listen voice-delete <id>    Remove a voice",
    "  bb listen speak <text>      Synthesize speech to a WAV file",
    "  bb listen condense <text>   Run the configured summarizer on a text",
  ].join("\n");

  bb.cli.register({
    name: "listen",
    summary: "Manage the offline speech runtime and its models",
    commands: [
      { name: "status", summary: "Show runtime and model state", usage: "bb listen status [--json]" },
      { name: "install-runtime", summary: "Install the speech runtime", usage: "bb listen install-runtime" },
      { name: "download", summary: "Download a model", usage: "bb listen download <model-id>" },
      { name: "delete", summary: "Delete a model", usage: "bb listen delete <model-id>" },
      { name: "voices", summary: "List installed voices", usage: "bb listen voices [--json]" },
      { name: "voice-download", summary: "Install a voice", usage: "bb listen voice-download <id>" },
      { name: "voice-delete", summary: "Remove a voice", usage: "bb listen voice-delete <id>" },
      { name: "speak", summary: "Synthesize speech to a WAV file", usage: "bb listen speak <text>" },
      {
        name: "condense",
        summary: "Run the configured summarizer on a text, to try a prompt or model",
        usage: "bb listen condense <text> [--json]",
      },
      {
        name: "transcribe",
        summary: "Transcribe an audio file — the microphone path, without a microphone",
        usage: "bb listen transcribe <file> [model-id]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const modelId = args[0];

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "status": {
          const state = await callHost("state", null);
          const values = await settings.get();
          const services = await bb.sdk.system.aiServices();
          const voice = services.selections.voice;
          const active = isSelectedForVoice(voice, bb.pluginId, SERVICE_ID);
          const command = selectCommand(SERVICE_ID);
          if (json) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ ...state, transcriptionSetting: command, active, model: values.model }),
            };
          }
          const installed = state.sttModels.filter((model) => model.installed);
          const running = state.sttModels.filter((model) => model.progress !== null);
          return {
            exitCode: 0,
            stdout: [
              `runtime:       ${state.setup.runtime.installed ? `installed (${state.setup.runtime.source})` : "not installed"}`,
              `ffmpeg:        ${state.setup.ffmpeg ? "found" : "not on PATH"}`,
              `language:      ${state.config.language}`,
              `BB voice:      ${voice.mode === "service" ? `${voice.pluginId}/${voice.serviceId}` : voice.mode}${active ? "" : `  (run \`${command}\` to use this plugin)`}`,
              `model:         ${values.model}`,
              `models ready:  ${installed.length === 0 ? "none" : installed.map((model) => `${model.id} (${model.source})`).join(", ")}`,
              ...(running.length === 0
                ? []
                : [`downloading:   ${running.map((model) => model.id).join(", ")}`]),
            ].join("\n"),
          };
        }

        case "install-runtime": {
          const { started } = await callHost("installRuntime", null);
          return {
            exitCode: 0,
            stdout: started
              ? "Installing the speech runtime. Watch `bb listen status` for the result."
              : "An install is already running.",
          };
        }

        case "download": {
          if (modelId === undefined) break;
          const { started } = await callHost("downloadModel", { modelId });
          return {
            exitCode: 0,
            stdout: started
              ? `Downloading ${modelId}. Watch \`bb listen status\` for progress.`
              : `${modelId} is already downloading.`,
          };
        }

        case "transcribe": {
          const file = args[0];
          if (file === undefined) break;
          const values = await settings.get();
          const result = await callHost("transcribeFile", {
            path: resolve(file),
            modelId: args[1] ?? values.model,
          });
          if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
          return result.error === null
            ? {
                exitCode: 0,
                stdout: `${result.text}\n\n(${(result.milliseconds / 1000).toFixed(1)}s)`,
              }
            : { exitCode: 1, stderr: result.error };
        }

        case "voices": {
          const state = await callHost("state", null);
          if (json) return { exitCode: 0, stdout: JSON.stringify(state.voices) };
          const installed = state.voices.filter((voice) => voice.installed);
          return {
            exitCode: 0,
            stdout:
              installed.length === 0
                ? "No voice installed. Install one on the Listen settings page, or run `bb listen voice-download <id>`."
                : installed
                    .map(
                      (voice) =>
                        `${voice.id === state.config.voiceModel ? "*" : " "} ${voice.id}  ${voice.languages.join(",")}  (${voice.source})`,
                    )
                    .join("\n"),
          };
        }

        case "voice-delete": {
          if (modelId === undefined) break;
          const { deleted } = await callHost("deleteVoice", { modelId });
          return deleted
            ? { exitCode: 0, stdout: `Deleted voice ${modelId}.` }
            : { exitCode: 1, stderr: `${modelId} is not installed by this plugin.` };
        }

        case "voice-download": {
          if (modelId === undefined) break;
          const { started } = await callHost("downloadVoice", { modelId });
          return {
            exitCode: 0,
            stdout: started
              ? `Installing voice ${modelId}. Watch \`bb listen voices\` for the result.`
              : `${modelId} is already installing.`,
          };
        }

        case "condense": {
          // Try the configured summarizer on a text without ending a turn —
          // the only way to check a prompt or a model change quickly.
          const text = args.join(" ").trim();
          if (text === "") break;
          const values = await settings.get();
          if (!values.summarize) {
            return {
              exitCode: 1,
              stderr: "Condensing is switched off (setting: summarize).",
            };
          }
          const started = Date.now();
          const project = await currentProjectId();
          const summary = await condense(text, {
            projectId: project,
            prompt:
              values.summaryPrompt.trim() === ""
                ? DEFAULT_SUMMARY_PROMPT
                : values.summaryPrompt,
          });
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          // Show what would actually be *spoken*, not the raw reply: the
          // filter still runs over a summary, and seeing the unfiltered text
          // here would send anyone tuning a prompt after the wrong problem.
          const spoken = spokenText(summary, text, values.language);
          if (json) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ summary, spoken: spoken?.text ?? null, seconds }),
            };
          }
          return spoken === null
            ? {
                exitCode: 1,
                stderr: `Nothing to speak after ${seconds}s — see the plugin log for why.`,
              }
            : {
                exitCode: 0,
                stdout: `${spoken.text}\n\n(${values.summaryBackend}, ${spoken.source}, ${seconds}s)`,
              };
        }

        case "speak": {
          // `--voice <id>` tries one voice without changing the setting —
          // the quickest way to tell a broken voice from a broken runtime.
          const voiceAt = args.indexOf("--voice");
          const voice = voiceAt === -1 ? null : (args[voiceAt + 1] ?? null);
          const text = args
            .filter((_, index) => voiceAt === -1 || (index !== voiceAt && index !== voiceAt + 1))
            .join(" ")
            .trim();
          if (text === "") break;
          const audio = await callHost("speak", { text, modelId: voice, sid: null });
          const file = join(tmpdir(), `listen-speak-${Date.now()}.wav`);
          writeFileSync(file, Buffer.from(audio.wavBase64, "base64"));
          if (json) return { exitCode: 0, stdout: JSON.stringify({ file, ...audio, wavBase64: undefined }) };
          return {
            exitCode: 0,
            stdout: `${file}\n(${(audio.milliseconds / 1000).toFixed(1)}s to synthesize, ${audio.sampleRate} Hz)`,
          };
        }

        case "delete": {
          if (modelId === undefined) break;
          const { deleted } = await callHost("deleteModel", { modelId });
          return deleted
            ? { exitCode: 0, stdout: `Deleted ${modelId}.` }
            : { exitCode: 1, stderr: `${modelId} is not downloaded here.` };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // Language and voice live in two places: BB's settings and the host's own
  // config file. Without this, changing a setting left the host speaking the
  // old language until the next plugin reload.
  settings.onChange(() => {
    void pushConfig().catch((cause) => {
      bb.log.warn(`could not send changed settings to the host: ${String(cause)}`);
    });
    bb.realtime.publish(CHANGED, {});
  });

  // Host calls are rejected while the plugin is still a load candidate, so
  // the first push waits for registration to commit.
  bb.background.service("config-sync", {
    async start(signal) {
      if (signal.aborted) return;
      try {
        await pushConfig();
      } catch (cause) {
        bb.log.warn(`could not send settings to the host: ${String(cause)}`);
      }
    },
  });

  bb.onDispose(() => {
    unsubscribe();
  });
}
