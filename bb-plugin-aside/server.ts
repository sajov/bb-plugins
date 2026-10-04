// bb-plugin-aside — backend.
//
// The sidenav reads its threads straight from the host's live view. The server
// only does what the frontend may not: writing calls against the host API
// (rename and reorder projects, sections, a thread's section), the bulk delete
// the host has no recursive equivalent for, and the three pieces of state we
// own — project colour, project tags and view. Tags are ours because the host's
// project model has no field for them.
//
// Both live server-side rather than in localStorage on purpose: order and
// collapsed rows should be the same on every device, the way bb has been
// syncing its own sidebar since 0.43.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { normalizeColor, validProjectId } from "./lib/colors";
import { collectFamilies } from "./lib/deletion";
import { MAX_TAGS_PER_PROJECT, normalizeTags, parseTagMap, type TagMap } from "./lib/tags";
import { parseViewState, type ViewState } from "./lib/view";

const projectId = z.string().min(1).max(200);
const sectionId = z.string().min(1).max(200);
const threadId = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(200);

const sectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
});

export const rpcContract = defineRpcContract({
  /**
   * Projects with the state we keep for them — the sidenav only has id + name.
   * Colour and tags travel together because they are read in the same breath,
   * on mount and after every `aside-changed`.
   */
  projects_state: {
    input: z.null(),
    output: z.object({
      colors: z.array(z.object({ projectId: z.string(), color: z.string() })),
      tags: z.array(
        z.object({ projectId: z.string(), tags: z.array(z.string()) }),
      ),
    }),
  },
  project_rename: {
    input: z.object({ projectId, name }),
    output: z.object({ id: z.string(), name: z.string() }),
  },
  project_reorder: {
    input: z.object({
      projectId,
      previousProjectId: z.string().nullable(),
      nextProjectId: z.string().nullable(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  project_set_color: {
    input: z.object({ projectId, color: z.string().nullable() }),
    output: z.object({ projectId: z.string(), color: z.string().nullable() }),
  },
  /**
   * The whole set at once, not one add and one remove. The menu edits a list
   * it is already holding, and a single write makes two windows editing the
   * same project converge on a state that was actually seen rather than on the
   * sum of two half-orders.
   */
  project_set_tags: {
    input: z.object({
      projectId,
      tags: z.array(z.string().max(200)).max(MAX_TAGS_PER_PROJECT),
    }),
    output: z.object({ projectId: z.string(), tags: z.array(z.string()) }),
  },

  sections_list: {
    input: z.null(),
    output: z.object({ sections: z.array(sectionSchema) }),
  },
  section_create: {
    input: z.object({ name, threadId: threadId.nullable() }),
    output: sectionSchema,
  },
  section_rename: {
    input: z.object({ sectionId, name }),
    output: sectionSchema,
  },
  /** Dissolves the section. Threads stay, they only lose the assignment. */
  section_delete: {
    input: z.object({ sectionId }),
    output: z.object({ updatedThreadCount: z.number() }),
  },
  thread_set_section: {
    input: z.object({ threadId, sectionId: sectionId.nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * Thread order. The host only keeps one for pinned threads
   * (`threads.reorderPinned`) — so whoever drags, pins. That happens visibly:
   * the card gets its pin, and the sidenav says so once.
   */
  thread_reorder: {
    input: z.object({
      threadId,
      previousThreadId: z.string().nullable(),
      nextThreadId: z.string().nullable(),
    }),
    output: z.object({ pinned: z.boolean() }),
  },
  /** Nesting: the gesture bb 0.43 has in its own sidebar. */
  thread_set_parent: {
    input: z.object({ threadId, parentThreadId: threadId.nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * "New sub-thread": a thread one level under another, created right away
   * rather than through the new-thread screen — there is no provider choice
   * to make, so nothing is gained by stopping for one. `spawn` already takes
   * `parentThreadId` directly; no separate `thread_set_parent` call needed.
   */
  thread_create_child: {
    input: z.object({ projectId, parentThreadId: threadId }),
    output: z.object({ threadId: z.string() }),
  },

  /**
   * Bulk deletion — the one destructive thing aside owns.
   *
   * It exists because the host's own delete is not recursive (see
   * lib/deletion.ts): deleting a family through bb's dialog leaves the agents
   * behind as new roots. Here every member is addressed individually, children
   * first. The frontend only reaches this after an explicit confirmation that
   * named the count.
   */
  threads_delete: {
    input: z.object({ threadIds: z.array(threadId).min(1).max(200) }),
    output: z.object({
      deletedCount: z.number(),
      failed: z.array(z.object({ threadId: z.string(), reason: z.string() })),
    }),
  },

  view_get: { input: z.null(), output: z.object({ view: z.unknown() }) },
  view_set: {
    input: z.object({ view: z.unknown() }),
    output: z.object({ ok: z.boolean() }),
  },
});

/** Realtime channel: one write, every open window follows. */
const CHANGED = "aside-changed";

const COLORS_KEY = "project-colors";
const TAGS_KEY = "project-tags";
const VIEW_KEY = "view";
const MAX_COLORS = 500;

export default async function plugin(bb: BbPluginApi) {
  async function readColors(): Promise<Record<string, string>> {
    const stored = await bb.storage.kv.get<Record<string, string>>(COLORS_KEY);
    if (stored === null || typeof stored !== "object") return {};
    const colors: Record<string, string> = {};
    for (const [id, value] of Object.entries(stored)) {
      const color = normalizeColor(value);
      if (!validProjectId(id) || color === null) continue;
      colors[id] = color;
      if (Object.keys(colors).length >= MAX_COLORS) break;
    }
    return colors;
  }

  async function readTags(): Promise<TagMap> {
    return parseTagMap(await bb.storage.kv.get<unknown>(TAGS_KEY), validProjectId);
  }

  bb.rpc.register(rpcContract, {
    projects_state: async () => {
      const [colors, tags] = await Promise.all([readColors(), readTags()]);
      return {
        colors: Object.entries(colors).map(([id, color]) => ({
          projectId: id,
          color,
        })),
        tags: Object.entries(tags).map(([id, list]) => ({
          projectId: id,
          tags: list,
        })),
      };
    },

    project_rename: async ({ projectId: id, name: next }) => {
      const project = await bb.sdk.projects.update({ projectId: id, name: next });
      bb.realtime.publish(CHANGED, { kind: "project" });
      return { id: project.id, name: project.name };
    },

    project_reorder: async ({ projectId: id, previousProjectId, nextProjectId }) => {
      await bb.sdk.projects.reorder({
        projectId: id,
        previousProjectId,
        nextProjectId,
      });
      bb.realtime.publish(CHANGED, { kind: "project-order" });
      return { ok: true };
    },

    project_set_color: async ({ projectId: id, color }) => {
      const colors = await readColors();
      const normalized = color === null ? null : normalizeColor(color);
      if (color !== null && normalized === null) {
        throw new Error("Invalid colour.");
      }
      if (normalized === null) delete colors[id];
      else colors[id] = normalized;
      await bb.storage.kv.set(COLORS_KEY, colors);
      bb.realtime.publish(CHANGED, { kind: "color" });
      return { projectId: id, color: normalized };
    },

    project_set_tags: async ({ projectId: id, tags }) => {
      const stored = await readTags();
      const normalized = normalizeTags(tags);
      // An empty set removes the entry instead of writing `[]` — see
      // parseTagMap: untagged has exactly one spelling.
      if (normalized.length === 0) delete stored[id];
      else stored[id] = normalized;
      await bb.storage.kv.set(TAGS_KEY, stored);
      bb.realtime.publish(CHANGED, { kind: "tags" });
      return { projectId: id, tags: normalized };
    },

    sections_list: async () => {
      // Newest first: a section just created should sit at the top of the
      // project, not behind all the older ones.
      const sections = await bb.sdk.threadSections.list();
      return {
        sections: [...sections]
          .sort((left, right) => right.createdAt - left.createdAt)
          .map(({ id, name: label, createdAt }) => ({ id, name: label, createdAt })),
      };
    },

    section_create: async ({ name: label, threadId: thread }) => {
      const section = await bb.sdk.threadSections.create({ name: label });
      // A section without a thread would be visible nowhere, so it gets its
      // first one right away.
      if (thread !== null) {
        await bb.sdk.threads.update({ threadId: thread, sectionId: section.id });
      }
      bb.realtime.publish(CHANGED, { kind: "section" });
      return { id: section.id, name: section.name, createdAt: section.createdAt };
    },

    section_rename: async ({ sectionId: id, name: label }) => {
      const section = await bb.sdk.threadSections.update({ id, name: label });
      bb.realtime.publish(CHANGED, { kind: "section" });
      return { id: section.id, name: section.name, createdAt: Date.now() };
    },

    section_delete: async ({ sectionId: id }) => {
      const result = await bb.sdk.threadSections.delete({ id });
      bb.realtime.publish(CHANGED, { kind: "section" });
      return { updatedThreadCount: result.updatedThreadCount };
    },

    thread_set_section: async ({ threadId: thread, sectionId: section }) => {
      await bb.sdk.threads.update({ threadId: thread, sectionId: section });
      bb.realtime.publish(CHANGED, { kind: "thread" });
      return { ok: true };
    },

    thread_reorder: async ({ threadId: thread, previousThreadId, nextThreadId }) => {
      const current = await bb.sdk.threads.get({ threadId: thread });
      const wasPinned = current.pinnedAt !== null;
      if (!wasPinned) await bb.sdk.threads.pin({ threadId: thread });
      await bb.sdk.threads.reorderPinned({
        threadId: thread,
        previousThreadId,
        nextThreadId,
      });
      bb.realtime.publish(CHANGED, { kind: "thread-order" });
      return { pinned: !wasPinned };
    },

    thread_set_parent: async ({ threadId: thread, parentThreadId }) => {
      if (parentThreadId === thread) {
        throw new Error("A thread cannot be its own parent.");
      }
      await bb.sdk.threads.update({ threadId: thread, parentThreadId });
      bb.realtime.publish(CHANGED, { kind: "thread" });
      return { ok: true };
    },

    thread_create_child: async ({ projectId: id, parentThreadId: parent }) => {
      const child = await bb.sdk.threads.spawn({
        projectId: id,
        parentThreadId: parent,
        // No provider picker: the project's own default, the same thing an
        // untouched new-thread screen would resolve to.
        environment: { type: "project-default" },
        prompt: "",
        origin: "plugin",
        visibility: "visible",
      });
      bb.realtime.publish(CHANGED, { kind: "thread" });
      return { threadId: child.id };
    },

    threads_delete: async ({ threadIds }) => {
      // The real tree, not the sidenav's picture of it: archived and hidden
      // children are invisible up front but would survive the delete.
      const ordered = await collectFamilies(threadIds, async (parent) => {
        // `archived` is a filter, not a switch: `true` returns ONLY archived
        // threads. Both passes are asked for explicitly rather than trusting
        // the default, because an archived agent left behind is exactly the
        // orphan this whole feature exists to prevent.
        const [live, archived] = await Promise.all([
          bb.sdk.threads.list({
            parentThreadId: parent,
            archived: false,
            includeHidden: true,
          }),
          bb.sdk.threads.list({
            parentThreadId: parent,
            archived: true,
            includeHidden: true,
          }),
        ]);
        return [...new Set([...live, ...archived].map((child) => child.id))];
      });

      const failed: { threadId: string; reason: string }[] = [];
      let deletedCount = 0;
      for (const id of ordered) {
        try {
          await bb.sdk.threads.delete({ threadId: id, childThreadsConfirmed: true });
          deletedCount += 1;
        } catch (cause) {
          // One thread refusing must not strand the rest half-deleted — a
          // family left in pieces is worse than a named failure.
          failed.push({
            threadId: id,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }

      bb.realtime.publish(CHANGED, { kind: "thread-deleted" });
      return { deletedCount, failed };
    },

    view_get: async () => ({
      view: parseViewState(await bb.storage.kv.get<unknown>(VIEW_KEY)),
    }),

    view_set: async ({ view }) => {
      const next: ViewState = parseViewState(view);
      await bb.storage.kv.set(VIEW_KEY, next);
      bb.realtime.publish(CHANGED, { kind: "view" });
      return { ok: true };
    },
  });

  bb.log.info("aside loaded");
}
