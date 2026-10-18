// bb-plugin-thread-board — frontend entry: the full-page board and the
// purpose bar in every thread header. Both read the same server state and
// refetch on its realtime signal.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Board } from "@/components/board";
import { PurposeBar } from "@/components/purpose-bar";
import type { Purpose } from "@/lib/purpose";

interface PurposeState {
  purposes: Record<string, Purpose>;
  markedDone: string[];
  staleDays: number;
  model: string;
  evaluating: string[];
}

function usePurposes() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PurposeState | null>(null);
  const refetch = useCallback(() => {
    rpc.call("purposes", null).then(setState, (cause: unknown) => toast.error(String(cause)));
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("purposes-changed", refetch);
  const run = useCallback(
    (promise: Promise<unknown>) => promise.catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause))),
    [],
  );
  return { rpc, state, run };
}

/** Relative times on screen move on even when nothing else changes. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function BoardPage() {
  const pluginId = experimental_usePluginId();
  const { threads, projects } = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const { rpc, state, run } = usePurposes();
  const now = useNow();
  // Root threads only: children are reached through their parent, and our
  // own hidden evaluation workers must never show up as work.
  const visible = threads.filter(
    (thread) => !thread.isHidden && !thread.isArchived && thread.parentThreadId === null && thread.originPluginId !== pluginId,
  );
  return (
    <Board
      threads={visible}
      projects={projects}
      purposes={state?.purposes ?? {}}
      markedDone={state?.markedDone ?? []}
      evaluating={state?.evaluating ?? []}
      staleDays={state?.staleDays ?? 7}
      model={state?.model ?? ""}
      now={now}
      onOpen={(threadId) => navigate.toThread(threadId)}
      onRefresh={(threadId) => run(rpc.call("refresh", { threadId }))}
      onSetDone={(threadId, done) => run(rpc.call("setDone", { threadId, done }))}
      onArchive={(threadId) => run(rpc.call("archive", { threadId }))}
      onEvaluateMany={(threadIds) => run(rpc.call("evaluateMany", { threadIds }))}
      onSend={(threadId, text) => run(rpc.call("send", { threadId, text }))}
    />
  );
}

function HeaderPurpose({ threadId, isCompactViewport }: { threadId: string; isCompactViewport: boolean }) {
  const { rpc, state, run } = usePurposes();
  const now = useNow();
  if (state === null) return null;
  return (
    <PurposeBar
      purpose={state.purposes[threadId]}
      evaluating={state.evaluating.includes(threadId)}
      compact={isCompactViewport}
      now={now}
      onRefresh={() => run(rpc.call("refresh", { threadId }))}
      onSend={(text) => run(rpc.call("send", { threadId, text }))}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Thread Board",
    icon: "Columns",
    path: "board",
    component: BoardPage,
  });
  app.slots.experimental_threadHeaderAction({
    id: "purpose",
    title: "Thread purpose",
    component: HeaderPurpose,
  });
});
