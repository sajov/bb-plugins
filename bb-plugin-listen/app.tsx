/**
 * Listen — the settings page.
 *
 * Everything a fresh install needs lives here, in the order someone new hits
 * it: install the runtime, download a model, point BB at it. Nothing in this
 * plugin requires editing a file or knowing npm, which is the whole reason
 * this page exists rather than a README.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { ModelState, SetupState, VoiceState } from "./contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Check, Close, SpeakerOff, SpeakerOn } from "./components/speech-icons";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  createRowSync,
  rowStatuses,
  SPEAKER_ICON,
  type RowStatus,
} from "./lib/speech/thread-rows";

interface State {
  setup: SetupState;
  sttModels: ModelState[];
  voices: VoiceState[];
  config: { language: string; voiceModel: string; voiceSid: number };
  summarize: boolean;
  transcriptionSetting: string;
  active: boolean;
}

/** The whole page's data, refetched whenever the host reports movement. */
function useListenState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("state", null).then((next) => {
      setState(next as State);
      setError(null);
    }, report);
  }, [rpc, report]);

  useEffect(refetch, [refetch]);
  // A download publishes about once a second; the page re-reads rather than
  // accumulating bytes from the signal, so a dropped one self-corrects.
  useRealtime("listen-changed", refetch);

  return { rpc, state, error, report, refetch };
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="text-sm font-medium">{title}</h3>
      {description === undefined ? null : (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Five dots, filled to the rating — the catalog's own scale. */
function Rating({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1" title={`${label}: ${value} of 5`}>
      <span className="text-muted-foreground">{label}</span>
      <span aria-label={`${value} of 5`}>
        {"●".repeat(value)}
        <span className="text-muted-foreground/40">{"○".repeat(5 - value)}</span>
      </span>
    </span>
  );
}

function SetupCard({
  setup,
  transcriptionSetting,
  active,
  onInstall,
}: {
  setup: SetupState;
  transcriptionSetting: string;
  active: boolean;
  onInstall: () => void;
}) {
  const { runtime, device } = setup;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {runtime.unsupported === null ? null : (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {runtime.unsupported}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Speech runtime{" "}
            {runtime.installed ? (
              <span className="text-muted-foreground">
                — installed
                {runtime.source === "pi" ? " (using your pi-listen copy)" : ""}
              </span>
            ) : (
              <span className="text-muted-foreground">— not installed</span>
            )}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            sherpa-onnx, about 33 MB. Downloaded once per machine, into this
            plugin's own directory.
          </p>
        </div>
        {runtime.installed ? (
          <Check className="size-5 text-muted-foreground" />
        ) : (
          <Button
            onClick={onInstall}
            disabled={runtime.installing || runtime.unsupported !== null}
          >
            {runtime.installing ? "Installing…" : "Install runtime"}
          </Button>
        )}
      </div>

      {runtime.error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {runtime.error}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Machine</dt>
          <dd>
            {device.platform}/{device.arch}, {device.cpus} cores
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Memory</dt>
          <dd>{formatMB(device.totalRamMB)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Free disk</dt>
          <dd>{device.freeDiskMB === 0 ? "unknown" : formatMB(device.freeDiskMB)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">ffmpeg</dt>
          <dd>{setup.ffmpeg ? "found" : "not on PATH"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Node</dt>
          <dd>{setup.node === null ? "not on PATH" : "found"}</dd>
        </div>
      </dl>

      {setup.node !== null ? null : (
        <p className="mt-3 text-sm text-muted-foreground">
          Speaking needs Node on PATH. BB's own binary is Electron, which
          refuses the audio buffers the speech engine produces, so synthesis
          runs in a separate Node process. Recognition works without it.
        </p>
      )}

      {setup.ffmpeg ? null : (
        <p className="mt-3 text-sm text-muted-foreground">
          BB records compressed audio, which needs ffmpeg to decode. Install it
          (<code>brew install ffmpeg</code> on macOS) or transcription will fail
          with that message.
        </p>
      )}

      <div className="mt-4 border-t border-border pt-4">
        <p className="text-sm font-medium">
          Point BB at this plugin{" "}
          {active ? (
            <span className="text-muted-foreground">— active</span>
          ) : (
            <span className="text-muted-foreground">— not active yet</span>
          )}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick Listen for voice input in Settings → AI services, or run this
          command. The microphone in the composer then uses the model below.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Input
            readOnly
            value={transcriptionSetting}
            aria-label="Command that selects this plugin"
            className="font-mono text-xs"
          />
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(transcriptionSetting);
            }}
          >
            Copy
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModelRow({
  model,
  runtimeReady,
  onDownload,
  onCancel,
  onDelete,
}: {
  model: ModelState;
  runtimeReady: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const percent =
    model.progress === null || model.progress.totalBytes === 0
      ? 0
      : Math.min(
          100,
          Math.round(
            (model.progress.downloadedBytes / model.progress.totalBytes) * 100,
          ),
        );
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">{model.name}</span>
          {model.recommended ? (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              recommended
            </span>
          ) : null}
          {model.source === "pi" ? (
            <span className="ml-2 text-xs text-muted-foreground">from pi-listen</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {model.progress !== null ? (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : model.installed ? (
            <Button variant="ghost" size="sm" onClick={onDelete}>
              Delete
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={onDownload}
              disabled={!runtimeReady}
              aria-label={
                runtimeReady
                  ? `Download ${model.name}`
                  : `Install the runtime before downloading ${model.name}`
              }
            >
              Download {model.size}
            </Button>
          )}
        </div>
      </div>

      <p className="mt-1 text-sm text-muted-foreground">{model.notes}</p>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{model.languages}</span>
        <Rating label="accuracy" value={model.accuracy} />
        <Rating label="speed" value={model.speed} />
        <span className="font-mono">{model.id}</span>
      </div>

      {model.progress === null ? null : (
        <div className="mt-2">
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Downloading… {percent}%</p>
        </div>
      )}

      {model.error === null ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {model.error}
        </p>
      )}
    </li>
  );
}

function VoiceRow({
  voice,
  active,
  runtimeReady,
  onDownload,
  onCancel,
  onDelete,
  onPreview,
}: {
  voice: VoiceState;
  active: boolean;
  runtimeReady: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onPreview: (sid: number) => void;
}) {
  const [sid, setSid] = useState(voice.defaultSid);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium">{voice.name}</span>
          {active ? (
            <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
              in use
            </span>
          ) : null}
          {voice.recommended ? (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              recommended
            </span>
          ) : null}
          {voice.source === "pi" ? (
            <span className="ml-2 text-xs text-muted-foreground">from pi-listen</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {voice.installed && voice.voices.length > 1 ? (
            <select
              value={sid}
              onChange={(event) => setSid(Number(event.target.value))}
              aria-label={`Voice within ${voice.name}`}
              className="h-7 rounded border border-border bg-background px-1 text-xs"
            >
              {voice.voices.map((option) => (
                <option key={option.sid} value={option.sid}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : null}
          {voice.installed ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => onPreview(sid)}>
                Preview
              </Button>
              <Button variant="ghost" size="sm" onClick={onDelete}>
                Delete
              </Button>
            </>
          ) : voice.progress !== null ? (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={onDownload}
              disabled={!runtimeReady}
            >
              Install {voice.size}
            </Button>
          )}
        </div>
      </div>

      <p className="mt-1 text-sm text-muted-foreground">{voice.notes}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 text-xs text-muted-foreground">
        <span>{voice.languages.join(", ")}</span>
        <span>{voice.license}</span>
        <span className="font-mono">{voice.id}</span>
      </div>

      {voice.progress === null ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          {voice.progress.phase === "download"
            ? `Downloading… ${
                voice.progress.totalBytes === 0
                  ? ""
                  : `${Math.round((voice.progress.bytes / voice.progress.totalBytes) * 100)}%`
              }`
            : `${voice.progress.phase}…`}
        </p>
      )}

      {voice.error === null ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {voice.error}
        </p>
      )}
    </li>
  );
}

function ListenSettings() {
  const { rpc, state, error, report, refetch } = useListenState();
  const [query, setQuery] = useState("");

  if (state === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {error ?? "Loading the speech runtime state…"}
      </p>
    );
  }

  const run = (promise: Promise<unknown>) => {
    promise.then(refetch, report);
  };
  const needle = query.trim().toLowerCase();
  const models =
    needle === ""
      ? state.sttModels
      : state.sttModels.filter((model) =>
          `${model.name} ${model.languages} ${model.notes} ${model.id}`
            .toLowerCase()
            .includes(needle),
        );

  return (
    <div className="max-w-3xl">
      {error === null ? null : (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}

      <Section
        title="Setup"
        description="Speech recognition runs entirely on this machine. Nothing is sent anywhere."
      >
        <SetupCard
          setup={state.setup}
          transcriptionSetting={state.transcriptionSetting}
          active={state.active}
          onInstall={() => run(rpc.call("installRuntime", null))}
        />
      </Section>

      <Section
        title="Voices"
        description={
          <>
            Each thread starts silent — press the speaker beside the
            microphone to hear its answers
            {state.summarize
              ? ", condensed to two or three sentences first."
              : " in full — turn on “Condense before speaking” above for a short spoken summary instead."}{" "}
            Install a voice that matches your language.
          </>
        }
      >
        <ul className="divide-y divide-border">
          {state.voices.map((voice) => (
            <VoiceRow
              key={voice.id}
              voice={voice}
              active={voice.id === state.config.voiceModel}
              runtimeReady={state.setup.runtime.installed}
              onDownload={() => run(rpc.call("downloadVoice", { modelId: voice.id }))}
              onCancel={() => run(rpc.call("cancelVoiceDownload", { modelId: voice.id }))}
              onDelete={() => run(rpc.call("deleteVoice", { modelId: voice.id }))}
              onPreview={(sid) => {
                rpc
                  .call("preview", { modelId: voice.id, sid })
                  .then((clip) => {
                    void new Audio(`data:audio/wav;base64,${clip.wavBase64}`).play();
                  }, report);
              }}
            />
          ))}
        </ul>
      </Section>

      <Section
        title="Recognition models"
        description={
          <>
            Open models from the sherpa-onnx catalog. Set the one you download
            as the plugin's <em>Recognition model</em> setting above.
          </>
        }
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by name, language or size…"
          aria-label="Filter models"
        />
        {models.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No model matches “{query}”.
          </p>
        ) : (
          <ul className={cn("mt-2 divide-y divide-border")}>
            {models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                runtimeReady={state.setup.runtime.installed}
                onDownload={() => run(rpc.call("downloadModel", { modelId: model.id }))}
                onCancel={() => run(rpc.call("cancelDownload", { modelId: model.id }))}
                onDelete={() => run(rpc.call("deleteModel", { modelId: model.id }))}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/**
 * The bridge between the player, which knows what to mark, and the content
 * script, which holds the host's row-status setter. Either may start first,
 * so the latest statuses wait here until the setter arrives.
 */
let latestRowStatuses = new Map<string, RowStatus>();
let applyRowStatuses: ((next: Map<string, RowStatus>) => void) | null = null;

function showRowStatuses(next: Map<string, RowStatus>) {
  latestRowStatuses = next;
  applyRowStatuses?.(next);
}

/**
 * Plays what the server announces, and shows that it is doing so.
 *
 * Mounted app-wide rather than in the thread: an answer can finish while the
 * user is looking at another thread, and they should still hear it. The clip
 * is claimed over RPC, so with two windows open exactly one speaks.
 */
function SpeechPlayer() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [speaking, setSpeaking] = useState<{
    text: string;
    threadId: string;
    threadTitle: string | null;
  } | null>(null);
  const [marked, setMarked] = useState<string[]>([]);

  const refetchMarked = useCallback(() => {
    rpc.call("speakingThreads", null).then(
      ({ threadIds }) => setMarked(threadIds),
      () => setMarked([]),
    );
  }, [rpc]);
  useEffect(refetchMarked, [refetchMarked]);
  useRealtime("listen-changed", refetchMarked);

  const speakingThreadId = speaking?.threadId ?? null;
  useEffect(() => {
    showRowStatuses(rowStatuses(marked, speakingThreadId));
  }, [marked, speakingThreadId]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setSpeaking(null);
  }, []);

  useRealtime(
    "listen-speak",
    useCallback(
      (payload: unknown) => {
        const id = (payload as { id?: unknown } | null)?.id;
        if (typeof id !== "string") return;
        void (async () => {
          const clip = await rpc.call("takeSpeech", { id });
          // Another window got there first; it is speaking, we are not.
          if (clip === null) return;

          audioRef.current?.pause();
          const audio = new Audio(`data:audio/wav;base64,${clip.wavBase64}`);
          audioRef.current = audio;
          setSpeaking({
            text: clip.text,
            threadId: clip.threadId,
            threadTitle: clip.threadTitle,
          });
          audio.addEventListener("ended", () => {
            if (audioRef.current === audio) stop();
          });
          try {
            await audio.play();
          } catch {
            // Autoplay can be refused before any interaction with the window.
            // The badge stays up with a play button rather than failing mute.
          }
        })();
      },
      [rpc, stop],
    ),
  );

  if (speaking === null) return null;
  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-2 rounded-lg border border-border bg-card p-3 shadow-lg">
      <SpeakerOn className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">{speaking.text}</p>
        <button
          type="button"
          className="mt-1 max-w-full truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => navigate.toThread(speaking.threadId)}
        >
          {speaking.threadTitle ?? "Open thread"}
        </button>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Stop speaking"
        onClick={stop}
      >
        <Close className="size-4" />
      </Button>
    </div>
  );
}

/**
 * The speaker button, beside BB's own microphone.
 *
 * Per thread on purpose: whether you want an answer read to you depends on
 * what you are doing in *this* conversation, not on a global preference.
 * Every thread starts silent — like a monitor you switch on for the one
 * conversation you want to hear, instead of hearing every thread you forgot
 * to mute.
 */
function SpeechToggle() {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId } = useBbContext();
  const [state, setState] = useState<{
    enabled: boolean;
    available: boolean;
  } | null>(null);

  const refetch = useCallback(() => {
    if (threadId === null) return;
    rpc.call("threadSpeech", { threadId }).then(setState, () => setState(null));
  }, [rpc, threadId]);

  useEffect(refetch, [refetch]);
  useRealtime("listen-changed", refetch);

  // No speaker while speaking is not set up: a switch that cannot make a
  // sound is noise. `listen-changed` brings it back once a voice installs.
  if (threadId === null || state === null || !state.available) return null;

  const set = (enabled: boolean) => {
    rpc.call("setThreadSpeech", { threadId, enabled }).then(setState, refetch);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-7", state.enabled ? undefined : "text-muted-foreground")}
      aria-pressed={state.enabled}
      aria-label={
        state.enabled
          ? `Reading answers aloud in this thread — click to stop`
          : `Not reading answers aloud in this thread — click to start`
      }
      onClick={() => set(!state.enabled)}
    >
      {state.enabled ? (
        <SpeakerOn className="size-4" />
      ) : (
        <SpeakerOff className="size-4" />
      )}
    </Button>
  );
}

export default definePluginApp((app) => {
  // BB's icon set has no speaker, and the row status only takes a name.
  app.experimental_icons.register({ name: SPEAKER_ICON, component: SpeakerOn });
  app.contentScripts.register({
    id: "listen-thread-rows",
    mount(context) {
      const set = context.experimental_setThreadRowStatus;
      // Older clients without row statuses simply show no marker.
      if (set === undefined) return;
      const sync = createRowSync(set);
      applyRowStatuses = sync;
      sync(latestRowStatuses);
      return () => {
        if (applyRowStatuses === sync) applyRowStatuses = null;
      };
    },
  });
  app.slots.settingsSection({
    id: "listen-setup",
    title: "Speech runtime and models",
    description:
      "Install the offline speech runtime and manage recognition models.",
    component: ListenSettings,
  });
  app.slots.experimental_appOverlay({
    id: "listen-speech",
    component: SpeechPlayer,
  });
  // Rendered just before BB's own voice and submit buttons.
  app.composer.customize({
    id: "listen-speech-toggle",
    // Not on the new-thread composer: there is no thread to switch yet, and
    // every new thread starts silent anyway.
    scopes: ["thread"],
    actions: [{ id: "speech", component: SpeechToggle }],
  });
});
