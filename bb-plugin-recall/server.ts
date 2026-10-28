// bb-plugin-recall — backend entry.
//
// Recall mirrors threads and tasks as Markdown into its own data directory,
// lets qmd index that mirror, and answers searches by fusing BB's keyword
// search with qmd's results. Three surfaces share one search function: the
// frontend over RPC, the `bb recall` CLI command, and the agent tools.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  emptyState,
  messagesFromEvents,
  mirrorPass,
  type IndexSources,
  type IndexState,
  type MirrorFiles,
  type ThreadSummary,
} from "./lib/indexer.js";
import { FOLDER_PREFIX, listMarkdown, parseFolderSetting, pathResolver, type FolderSource } from "./lib/folders.js";
import { docFileName, type TaskDoc } from "./lib/mirror.js";
import { nodeExec, Qmd, QMD_COLLECTION } from "./lib/qmd.js";
import {
  buildCatalog,
  combine,
  hitsFromKeyword,
  hitsFromQmd,
  type Catalog,
  type FolderInfo,
  type RecallHit,
  type TaskInfo,
  type ThreadInfo,
} from "./lib/search.js";

const kindSchema = z.enum(["thread", "task", "file"]);
const modeSchema = z.enum(["fast", "smart"]);

const hitSchema = z.object({
  key: z.string(),
  kind: kindSchema,
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  via: z.array(z.enum(["keyword", "semantic"])),
  source: z.string(),
  context: z.string().nullable(),
  updatedAt: z.number().nullable(),
});

const statusSchema = z.object({
  qmdAvailable: z.boolean(),
  phase: z.enum(["starting", "inactive", "idle", "mirroring", "indexing", "embedding", "error"]),
  documents: z.number(),
  lastIndexedAt: z.number().nullable(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  error: z.string().nullable(),
  counts: z.object({ threads: z.number(), tasks: z.number(), files: z.number() }),
  folders: z.array(z.object({ label: z.string(), root: z.string(), files: z.number() })),
  invalidFolders: z.array(z.string()),
  /** Host whose disk holds the folders; null when it is not unambiguous. */
  hostId: z.string().nullable(),
  defaultMode: z.enum(["fast", "smart"]),
});
export type RecallStatus = z.infer<typeof statusSchema>;

const searchInput = z.object({
  query: z.string().trim().min(1).max(500),
  mode: modeSchema.optional(),
  kinds: z.array(kindSchema).min(1).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

const searchOutput = z.object({
  hits: z.array(hitSchema),
  mode: modeSchema,
  /** True when qmd was unavailable or failed and only BB's keyword search answered. */
  fallback: z.boolean(),
  tookMs: z.number(),
});
export type SearchResult = z.infer<typeof searchOutput>;
export type Hit = z.infer<typeof hitSchema>;

export const rpcContract = defineRpcContract({
  search: { input: searchInput, output: searchOutput },
  status: { input: z.null(), output: statusSchema },
  reindex: { input: z.null(), output: z.object({ started: z.boolean() }) },
  get: {
    input: z.object({ kind: kindSchema, id: z.string().min(1).max(4096) }),
    output: z.object({ content: z.string().nullable() }),
  },
});

export const STATUS_CHANGED = "status-changed";

const MAX_GET_CHARS = 20_000;
// Bump the suffix whenever the mirror format changes: a new key forces a full rewrite.
const STATE_KEY = "index-state-v2";
// The server caps one events page at 100 rows.
const EVENT_PAGE = 100;

function runBb(args: string[], signal: AbortSignal): Promise<string> {
  const binary = process.env.BB_CLI || "bb";
  return new Promise((resolve, reject) => {
    execFile(binary, args, { signal, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

const taskListSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});

function sleep(ms: number, signal: AbortSignal, wake: { fire?: () => void }): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      wake.fire = undefined;
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake.fire = done;
    signal.addEventListener("abort", done, { once: true });
  });
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    sourceThreads: {
      type: "boolean",
      label: "Index threads",
      description: "User and assistant messages of every thread. Tool output is never indexed.",
      default: false,
    },
    sourceArchived: {
      type: "boolean",
      label: "Include archived threads",
      default: false,
    },
    sourceTasks: {
      type: "boolean",
      label: "Index BB tasks",
      description: "Title, status and description of every task in the Tasks plugin.",
      default: false,
    },
    folders: {
      type: "string",
      label: "Markdown folders",
      description:
        "One absolute path per line, e.g. an Obsidian vault or a docs folder on the BB server. Lines starting with # are ignored. .git, .obsidian and node_modules are skipped.",
      experimental_multiline: true,
      default: "",
    },
    defaultMode: {
      type: "select",
      label: "Default search mode",
      description: "fast: keywords only, instant. smart: keywords and meaning, reranked; a few seconds.",
      options: ["smart", "fast"],
      default: "smart",
    },
    intervalSeconds: {
      type: "number",
      label: "Index interval (seconds)",
      description: "How often changed threads, tasks and files are picked up. Minimum 30.",
      default: 60,
    },
  });

  const qmd = new Qmd(nodeExec());
  const status: RecallStatus = {
    qmdAvailable: false,
    phase: "starting",
    documents: 0,
    lastIndexedAt: null,
    progress: null,
    error: null,
    counts: { threads: 0, tasks: 0, files: 0 },
    folders: [],
    invalidFolders: [],
    hostId: null,
    defaultMode: "smart",
  };
  const wake: { fire?: () => void } = {};
  let catalog: Catalog = buildCatalog(new Map(), new Map(), []);
  let threadInfo = new Map<string, ThreadInfo>();
  let activeThreadIds = new Set<string>();
  let taskInfo = new Map<string, TaskInfo>();
  let config = {
    threads: false,
    archived: false,
    tasks: false,
    folders: [] as FolderSource[],
    intervalMs: 60_000,
  };

  function setStatus(patch: Partial<RecallStatus>) {
    Object.assign(status, patch);
    bb.realtime.publish(STATUS_CHANGED, status);
  }

  async function loadConfig() {
    const values = await settings.get();
    const parsed = parseFolderSetting(values.folders);
    config = {
      threads: values.sourceThreads,
      archived: values.sourceArchived,
      tasks: values.sourceTasks,
      folders: parsed.folders,
      intervalMs: Math.max(30, values.intervalSeconds || 60) * 1000,
    };
    setStatus({ invalidFolders: parsed.invalid, defaultMode: values.defaultMode === "fast" ? "fast" : "smart" });
  }
  // A changed source should show up now, not after the next interval.
  settings.onChange(() => {
    void loadConfig().then(() => wake.fire?.());
  });

  // The mirror lives in the plugin's own directory, next to its data.db.
  const mirrorDir = () => join(bb.server.experimental_dataDir, "plugins", "recall", "mirror");

  const files: MirrorFiles = {
    async list() {
      return readdir(mirrorDir()).catch(() => []);
    },
    async write(name, content) {
      await writeFile(join(mirrorDir(), name), content, "utf8");
    },
    async remove(name) {
      await rm(join(mirrorDir(), name), { force: true });
    },
  };

  async function projectNames(signal: AbortSignal): Promise<Map<string, string>> {
    try {
      const projects = await bb.sdk.projects.list({ signal });
      return new Map(projects.map((project) => [project.id, project.name]));
    } catch {
      return new Map();
    }
  }

  const sources: IndexSources = {
    async listThreads(signal) {
      const summaries: ThreadSummary[] = [];
      const activeIds = new Set<string>();
      if (!config.threads) {
        threadInfo = new Map();
        activeThreadIds.clear();
        return summaries;
      }
      const names = await projectNames(signal);
      for (const archived of config.archived ? [false, true] : [false]) {
        for (let offset = 0; ; offset += 200) {
          const page = await bb.sdk.threads.list({ archived, includeHidden: false, limit: 200, offset, signal });
          for (const thread of page) {
            if (thread.deletedAt !== null) continue;
            if (!archived) activeIds.add(thread.id);
            summaries.push({
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title ?? thread.titleFallback ?? "",
              updatedAt: thread.updatedAt,
            });
          }
          if (page.length < 200) break;
        }
      }
      // Keep the last completed classification if a later listing fails.
      activeThreadIds = activeIds;
      threadInfo = new Map(
        summaries.map((thread) => [
          thread.id,
          { title: thread.title, projectName: names.get(thread.projectId) ?? null, updatedAt: thread.updatedAt },
        ]),
      );
      return summaries;
    },
    async threadMessages(threadId, signal) {
      const events: { type: string; data: unknown }[] = [];
      let afterSeq: string | undefined;
      for (;;) {
        const page = await bb.sdk.threads.events.list({
          threadId,
          afterSeq,
          limit: String(EVENT_PAGE),
          types: ["client/turn/requested", "item/completed"],
          signal,
        });
        events.push(...page);
        if (page.length < EVENT_PAGE) break;
        afterSeq = String(page[page.length - 1].seq);
      }
      return messagesFromEvents(events);
    },
    async listTasks(signal) {
      if (!config.tasks) {
        taskInfo = new Map();
        return [];
      }
      const tasks: TaskDoc[] = [];
      let cursor: string | null | undefined;
      try {
        do {
          const args = ["tasks", "list", "--json", "--limit", "500", ...(cursor ? ["--cursor", cursor] : [])];
          const page = taskListSchema.parse(JSON.parse(await runBb(args, signal)));
          for (const task of page.tasks) tasks.push({ ...task, description: task.description ?? "" });
          cursor = page.nextCursor;
        } while (cursor);
      } catch (error) {
        // Tasks are optional: without the Tasks plugin Recall still indexes threads.
        bb.log.warn(`tasks unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
      taskInfo = new Map(
        tasks.map((task) => [
          task.id,
          { key: task.key, title: task.title, status: task.status, updatedAt: Date.parse(task.updatedAt) || 0 },
        ]),
      );
      return tasks;
    },
  };

  async function scanFolders(): Promise<{ infos: FolderInfo[]; total: number }> {
    const infos: FolderInfo[] = [];
    const summary: RecallStatus["folders"] = [];
    let total = 0;
    for (const folder of config.folders) {
      const found = await listMarkdown(folder.root);
      total += found.length;
      summary.push({ label: folder.label, root: folder.root, files: found.length });
      infos.push({ ...folder, resolve: pathResolver(found) });
    }
    setStatus({ folders: summary });
    return { infos, total };
  }

  async function resolveHostId(): Promise<string | null> {
    try {
      const hosts = await bb.sdk.hosts.list();
      // Folder paths name the server's disk; only a single host is unambiguous.
      return hosts.length === 1 ? hosts[0].id : null;
    } catch {
      return null;
    }
  }

  function hasSources(): boolean {
    return config.threads || config.tasks || config.folders.length > 0;
  }

  function pauseWithoutSources(): boolean {
    if (hasSources()) return false;
    threadInfo.clear();
    activeThreadIds.clear();
    taskInfo.clear();
    catalog = buildCatalog(threadInfo, taskInfo, []);
    setStatus({ phase: "inactive", documents: 0, counts: { threads: 0, tasks: 0, files: 0 }, folders: [], lastIndexedAt: null, progress: null, error: null });
    return true;
  }

  let environmentChecked = false;
  async function indexOnce(signal: AbortSignal) {
    await loadConfig();
    // No source means no mirror, filesystem scan, qmd probe or external corpus access.
    if (signal.aborted || pauseWithoutSources()) return;
    if (!environmentChecked) {
      setStatus({ qmdAvailable: await qmd.available(), hostId: await resolveHostId() });
      environmentChecked = true;
    }
    // Settings may have changed while the optional qmd/host probes were awaiting.
    if (signal.aborted || pauseWithoutSources()) return;
    await mkdir(mirrorDir(), { recursive: true });
    const previous = (await bb.storage.kv.get<IndexState>(STATE_KEY)) ?? emptyState();
    setStatus({ phase: "mirroring", progress: null, error: null });
    const pass = await mirrorPass(sources, files, previous, signal, (done, total) => {
      // Throttle realtime traffic during the first full pass.
      if (done === total || done % 10 === 0) setStatus({ progress: { done, total } });
    });
    await bb.storage.kv.set(STATE_KEY, pass.state);
    const folders = await scanFolders();
    catalog = buildCatalog(threadInfo, taskInfo, folders.infos);
    const counts = {
      threads: Object.keys(pass.state.threads).length,
      tasks: Object.keys(pass.state.tasks).length,
      files: folders.total,
    };
    const mirrorChanged = pass.written > 0 || pass.removed > 0 || status.lastIndexedAt === null;
    if (status.qmdAvailable && (mirrorChanged || config.folders.length > 0)) {
      await qmd.syncCollections(
        [
          { name: QMD_COLLECTION, dir: mirrorDir() },
          ...config.folders.map((folder) => ({ name: folder.collection, dir: folder.root })),
        ],
        (name) => name.startsWith(FOLDER_PREFIX),
      );
      setStatus({ phase: "indexing", progress: null });
      // qmd hashes every file, so an unchanged folder costs a scan but no embedding.
      await qmd.update(signal);
      setStatus({ phase: "embedding" });
      await qmd.embed(signal);
    }
    setStatus({
      phase: "idle",
      documents: counts.threads + counts.tasks + counts.files,
      counts,
      lastIndexedAt: Date.now(),
      progress: null,
    });
  }

  bb.background.service("indexer", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await indexOnce(signal);
        } catch (error) {
          if (signal.aborted) break;
          const message = error instanceof Error ? error.message : String(error);
          bb.log.warn(`index pass failed: ${message}`);
          setStatus({ phase: "error", error: message, progress: null });
        }
        await sleep(config.intervalMs, signal, wake);
      }
    },
  });

  async function keywordHits(query: string, limit: number, signal?: AbortSignal): Promise<RecallHit[]> {
    if (!config.threads) return [];
    const result = await bb.sdk.threads.search({ query, limitPerGroup: String(limit), signal });
    const entries = config.archived ? [...result.active.results, ...result.archived.results] : result.active.results;
    return hitsFromKeyword(
      entries.map((entry) => ({
        threadId: entry.thread.id,
        title: entry.thread.title ?? entry.thread.titleFallback ?? entry.thread.id,
        snippet: entry.matches[0]?.text ?? "",
      })),
      catalog,
    );
  }

  async function search(input: z.infer<typeof searchInput>, signal?: AbortSignal): Promise<SearchResult> {
    const started = Date.now();
    const mode = input.mode ?? status.defaultMode;
    if (!hasSources()) return { hits: [], mode, fallback: true, tookMs: Date.now() - started };
    const wantsThreads = !input.kinds || input.kinds.includes("thread");
    const collections = [QMD_COLLECTION, ...config.folders.map((folder) => folder.collection)];
    const [keyword, semantic] = await Promise.all([
      wantsThreads ? keywordHits(input.query, input.limit, signal).catch(() => []) : Promise.resolve([]),
      status.qmdAvailable && status.lastIndexedAt !== null
        ? qmd
            .search(input.query, mode, input.limit * 3, signal, collections)
            .then((found) => hitsFromQmd(found, catalog))
            .catch((error: unknown) => {
              bb.log.warn(`qmd search failed: ${error instanceof Error ? error.message : String(error)}`);
              return null;
            })
        : Promise.resolve(null),
    ]);
    const hits = combine(keyword, semantic ?? [], input.limit * 2)
      .filter((hit) => sourceEnabled(hit.kind, hit.id) && (!input.kinds || input.kinds.includes(hit.kind)))
      .slice(0, input.limit);
    return { hits, mode, fallback: semantic === null, tookMs: Date.now() - started };
  }

  function clipDocument(content: string): string {
    return content.length > MAX_GET_CHARS ? `${content.slice(0, MAX_GET_CHARS)}\n… (truncated)` : content;
  }

  function sourceEnabled(kind: "thread" | "task" | "file", id: string): boolean {
    // Unknown cached IDs cannot be assumed active when archived threads are off.
    if (kind === "thread") return config.threads && (config.archived || activeThreadIds.has(id));
    if (kind === "task") return config.tasks;
    return config.folders.some((folder) => resolvePath(id).startsWith(folder.root + sep));
  }

  async function getDocument(kind: "thread" | "task" | "file", id: string): Promise<string | null> {
    if (!sourceEnabled(kind, id)) return null;
    try {
      if (kind === "file") {
        // Only files inside a configured folder may be read; the id comes from the client.
        const path = resolvePath(id);
        const allowed = config.folders.some((folder) => path.startsWith(folder.root + sep));
        if (!allowed || !path.toLowerCase().endsWith(".md")) return null;
        return clipDocument(await readFile(path, "utf8"));
      }
      return clipDocument(await readFile(join(mirrorDir(), docFileName(kind, id)), "utf8"));
    } catch {
      return null;
    }
  }

  function reindex(): boolean {
    if (!hasSources() || !wake.fire) return false;
    wake.fire();
    return true;
  }

  bb.rpc.register(rpcContract, {
    search: (input) => search(input),
    status: () => ({ ...status }),
    reindex: () => ({ started: reindex() }),
    get: async ({ kind, id }) => ({ content: await getDocument(kind, id) }),
  });

  function formatHit(hit: RecallHit): string {
    const ref = hit.kind === "thread" ? `@thread:${hit.id}` : hit.kind === "file" ? hit.id : hit.context ?? hit.id;
    const origin = [hit.source, hit.context].filter(Boolean).join(" · ");
    return `- ${hit.title} — ${origin} (${ref})\n  ${hit.snippet.slice(0, 200)}`;
  }

  bb.agents.registerTool({
    name: "recall_search",
    description:
      "Search past BB threads and tasks by meaning and keywords. Use it before starting work to find earlier discussions, decisions and tickets on the same topic.",
    presentation: { label: { pending: "Searching past work", completed: "Searched past work" } },
    parameters: z.object({
      query: z.string().min(1).max(500),
      kinds: z.array(kindSchema).min(1).optional(),
      mode: modeSchema.optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    async execute({ query, kinds, mode, limit }, { signal }) {
      const result = await search({ query, kinds, mode, limit: limit ?? 8 }, signal);
      if (result.hits.length === 0) return "No matches.";
      const note = result.fallback ? "\n(keyword search only: semantic index not ready)" : "";
      return result.hits.map(formatHit).join("\n") + note;
    },
  });

  bb.agents.registerTool({
    name: "recall_get",
    description:
      "Read the indexed text of one hit from recall_search: a thread (user and assistant messages, no tool output), a task, or a file (pass its absolute path as id).",
    presentation: { label: { pending: "Reading past work", completed: "Read past work" } },
    parameters: z.object({ kind: kindSchema, id: z.string().min(1).max(4096) }),
    async execute({ kind, id }) {
      return (await getDocument(kind, id)) ?? `No indexed ${kind} ${id}.`;
    },
  });

  bb.cli.register(
    defineCli({
      name: "recall",
      summary: "Semantic search across BB threads, tasks and Markdown folders",
      commands: {
        search: cliCommand({
          summary: "Search threads and tasks by meaning and keywords",
          positionals: [{ name: "query", description: "What to look for", required: true, variadic: true }],
          options: {
            kind: { type: "enum", values: ["thread", "task", "file"], description: "Only this kind of result" },
            mode: { type: "enum", values: ["fast", "smart"], description: "fast: keywords only; smart: hybrid with reranking (default from settings)" },
            limit: { type: "integer", min: 1, max: 50, default: 10, description: "Maximum results, 1-50" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const query = [input.positionals.query].flat().join(" ");
            const limit = Number(input.options.limit ?? 10);
            const mode = input.options.mode === "fast" || input.options.mode === "smart" ? input.options.mode : undefined;
            const kind =
              input.options.kind === "thread" || input.options.kind === "task" || input.options.kind === "file"
                ? input.options.kind
                : undefined;
            const result = await search(
              { query, mode, limit, kinds: kind ? [kind] : undefined },
              ctx.signal,
            );
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
            if (result.hits.length === 0) return { exitCode: 0, stdout: "No matches." };
            return { exitCode: 0, stdout: result.hits.map(formatHit).join("\n") };
          },
        }),
        status: cliCommand({
          summary: "Show the index state",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(status, null, 2) };
            const when = status.lastIndexedAt ? new Date(status.lastIndexedAt).toISOString() : "never";
            return {
              exitCode: 0,
              stdout: [
                `qmd: ${status.qmdAvailable ? "available" : "missing"}`,
                `phase: ${status.phase}`,
                `threads: ${status.counts.threads} · tasks: ${status.counts.tasks} · files: ${status.counts.files}`,
                ...status.folders.map((folder) => `folder ${folder.label}: ${folder.files} files (${folder.root})`),
                ...status.invalidFolders.map((line) => `ignored folder line (not an absolute path): ${line}`),
                `last indexed: ${when}`,
                ...(status.error ? [`error: ${status.error}`] : []),
              ].join("\n"),
            };
          },
        }),
        reindex: cliCommand({
          summary: "Start an index pass now instead of waiting for the next minute",
          async run() {
            if (!hasSources()) {
              return { exitCode: 1, stderr: "Recall is inactive; choose sources in plugin settings first." };
            }
            if (!reindex()) {
              throw new PluginCliError("an index pass is already running", {
                code: "busy",
                hint: "Run `bb recall status` to follow it.",
              });
            }
            return { exitCode: 0, stdout: "Index pass started." };
          },
        }),
      },
    }),
  );
}
