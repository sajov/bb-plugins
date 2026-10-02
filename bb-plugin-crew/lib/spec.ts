// The crew file (`crew.yaml`): schema, inheritance, validation, order, YAML.
//
// Everything here is pure. The server feeds in the provider catalogue and the
// `--confirm-full` flag; the result is a list of problems plus the resolved
// members that `sync.ts` works from. Keeping inheritance in one place means
// plan, apply, the CLI and the panel can never disagree about what a member
// actually gets.
import YAML from "yaml";
import { z } from "zod";

export const PERMISSIONS = ["ask", "accept-edits", "auto", "full"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Members with these permissions change files, so `auto` gives them a worktree. */
export const WRITING_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "accept-edits",
  "auto",
  "full",
]);

export const LINK_KINDS = ["assigns_to", "works_with", "escalates_to", "can_read"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** BB's per-thread instruction limit (4096 characters). */
export const INSTRUCTION_LIMIT = 4096;

// `environment` accepts the object form from the concept and the short string
// form (`auto`, `host:<id>`), because both read naturally in YAML.
const environmentObject = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }).strict(),
  z.object({ type: z.literal("reuse") }).strict(),
  z.object({ type: z.literal("worktree") }).strict(),
  z.object({ type: z.literal("host"), hostId: z.string().min(1) }).strict(),
]);
export const environmentSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value.startsWith("host:")) return { type: "host", hostId: value.slice(5) };
  return { type: value };
}, environmentObject);
export type EnvironmentSpec = z.infer<typeof environmentObject>;

export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
export const SERVICE_TIERS = ["default", "fast"] as const;

const idSchema = z.string().trim().min(1).max(64);
const permissionSchema = z.enum(PERMISSIONS);

const memberSchema = z
  .object({
    id: idSchema,
    lead: z.boolean().optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    /** Optional; BB's own default for the model applies when absent. Same values as the SDK's reasoningLevel. */
    reasoningLevel: z.enum(REASONING_LEVELS).optional(),
    /** Optional; only for providers that offer service tiers. */
    serviceTier: z.enum(SERVICE_TIERS).optional(),
    role: z.string().default(""),
    instructions: z.string().optional(),
    permissions: permissionSchema.optional(),
    environment: environmentSchema.optional(),
    skills: z.array(z.string().min(1)).default([]),
    /** Stand-in for the lead towards other crews (§3.9.4); used from E3 on. */
    deputy: z.string().optional(),
    /** Merges delivered crew branches into main on green checks (§3.9.1). An explicit grant, never read from the role text. */
    integrator: z.boolean().optional(),
    /** First assignment in the kickoff brief; default is "wait for instructions". */
    kickoff: z.string().optional(),
  })
  .strict();

const groupSchema = z
  .object({
    id: idSchema,
    instructions: z.string().optional(),
    skills: z.array(z.string().min(1)).default([]),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permissions: permissionSchema.optional(),
    environment: environmentSchema.optional(),
    members: z.array(memberSchema).min(1),
  })
  .strict();

const linkSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: z.enum(LINK_KINDS),
  })
  .strict();

export const crewSpecSchema = z
  .object({
    version: z.coerce.string().pipe(z.literal("1")),
    name: idSchema,
    summary: z.string().default(""),
    instructions: z.string().optional(),
    skills: z.array(z.string().min(1)).default([]),
    messaging: z.enum(["open", "links"]).default("open"),
    permissions: permissionSchema.default("accept-edits"),
    environment: environmentSchema.default({ type: "auto" }),
    crossCrew: z.enum(["leads", "open", "none"]).default("leads"),
    /** Loop protection (§3.4): the message that would reach this step is not delivered. */
    maxSteps: z.number().int().min(2).max(100).default(6),
    maxMessagesPerChainPerHour: z.number().int().min(1).max(1000).default(20),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    kickoff: z.string().optional(),
    task: z.string().optional(),
    /** Branch the crews deliver into (§3.9.1). */
    baseBranch: z.string().trim().min(1).default("main"),
    /** Shell command run in the crew branch's worktree; "green" means exit code 0 (§3.9.1, local case). */
    checks: z.string().trim().min(1).optional(),
    /** Minutes the lead may be busy before its deputy answers other crews (§3.9.4). */
    leadBusyTimeout: z.number().int().min(1).max(1440).default(10),
    /** Follow-up period per tier in minutes (§3.6); rung n fires after n periods. */
    followUps: z
      .object({
        p0: z.number().min(0.1).max(10_080),
        p1: z.number().min(0.1).max(10_080),
        p2: z.number().min(0.1).max(10_080),
        p3: z.number().min(0.1).max(10_080),
      })
      .partial()
      .strict()
      .default({}),
    waitsFor: z
      .array(
        z
          .object({
            task: z.string().min(1),
            until: z.string().regex(/^(merged|done|comment:.+)$/),
          })
          .strict(),
      )
      .default([]),
    groups: z.array(groupSchema).min(1),
    links: z.array(linkSchema).default([]),
  })
  .strict();

export type CrewSpec = z.infer<typeof crewSpecSchema>;

export const TIERS = ["p0", "p1", "p2", "p3"] as const;
export type Tier = (typeof TIERS)[number];
/** Default follow-up periods in minutes (§3.6). */
export const DEFAULT_FOLLOW_UPS: Record<Tier, number> = { p0: 15, p1: 60, p2: 240, p3: 1440 };

export function followUpMinutes(spec: Pick<CrewSpec, "followUps"> | null, tier: Tier): number {
  return spec?.followUps?.[tier] ?? DEFAULT_FOLLOW_UPS[tier];
}

/**
 * Whether a member may merge into main (§3.9.1). Merging is a right, so it is
 * granted by the explicit `integrator: true` field and never inferred from the
 * free-text role. Stored configs from before the field count as not granted.
 */
export function isIntegrator(config: unknown): boolean {
  return typeof config === "object" && config !== null && (config as { integrator?: unknown }).integrator === true;
}
export type CrewSpecInput = z.input<typeof crewSpecSchema>;
export type MemberSpec = CrewSpec["groups"][number]["members"][number];

/**
 * Where a member's thread runs.
 *
 * - `crew-root`: the lead. Its environment *is* the crew environment.
 * - `shared`: reuses the lead's environment (readers, or everyone under `reuse`).
 * - `own-worktree`: a managed worktree of its own (writers under `auto`, or `worktree`).
 * - `host`: a managed worktree on the named host.
 */
export type Placement =
  | { kind: "crew-root"; workspace: "managed-worktree" | "project-default" }
  | { kind: "shared" }
  | { kind: "own-worktree" }
  | { kind: "host"; hostId: string };

export type ResolvedMember = {
  /** `{group}-{member}`, unique within the crew. */
  key: string;
  groupId: string;
  memberId: string;
  address: string;
  lead: boolean;
  provider: string | null;
  model: string | null;
  reasoningLevel: (typeof REASONING_LEVELS)[number] | null;
  serviceTier: (typeof SERVICE_TIERS)[number] | null;
  permissions: Permission;
  environment: EnvironmentSpec;
  placement: Placement;
  role: string;
  /** Crew → group → member instructions, most general first. */
  instructions: string[];
  skills: string[];
  deputy: string | null;
  integrator: boolean;
  kickoff: string | null;
};

export type Problem = {
  level: "error" | "warning";
  code: string;
  message: string;
};

/** What the provider catalogue says; absent means "not checked". */
export type Catalog = {
  /** provider id → model ids and names it offers. */
  providers: Map<string, Set<string>>;
};

/** Skill names known here (global, project and BB global skills); absent means "not checked". */
export type SkillsCatalog = {
  names: ReadonlySet<string>;
};

export type ValidateOptions = {
  catalog?: Catalog | null;
  /** Known skill names for the unknown-skill warning; null skips the check. */
  skills?: SkillsCatalog | null;
  /** `--confirm-full`: the human has seen that a member runs with `full`. */
  confirmFull?: boolean;
};

export type Validation = {
  spec: CrewSpec | null;
  members: ResolvedMember[];
  problems: Problem[];
};

export function hasErrors(problems: readonly Problem[]): boolean {
  return problems.some((problem) => problem.level === "error");
}

const FORBIDDEN = /[.@\s]/;

/** Parse YAML text into a plain value; syntax errors become a problem. */
export function parseCrewYaml(text: string): { value: unknown; problems: Problem[] } {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    return {
      value: null,
      problems: doc.errors.map((error) => ({
        level: "error" as const,
        code: "yaml",
        message: error.message.split("\n")[0] ?? "Invalid YAML",
      })),
    };
  }
  return { value: doc.toJS(), problems: [] };
}

export function serializeCrew(spec: CrewSpecInput | CrewSpec): string {
  return YAML.stringify(spec, { lineWidth: 0 });
}

export function memberKey(groupId: string, memberId: string): string {
  return `${groupId}-${memberId}`;
}

/** Validate a crew file given as YAML text or as an already parsed value. */
export function validateCrew(input: string | unknown, options: ValidateOptions = {}): Validation {
  let value = input;
  if (typeof input === "string") {
    const parsed = parseCrewYaml(input);
    if (parsed.problems.length > 0) return { spec: null, members: [], problems: parsed.problems };
    value = parsed.value;
  }

  const result = crewSpecSchema.safeParse(value);
  if (!result.success) {
    return {
      spec: null,
      members: [],
      problems: result.error.issues.map((issue) => ({
        level: "error" as const,
        code: "schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
    };
  }
  const spec = result.data;
  const problems: Problem[] = [];
  const error = (code: string, message: string) => problems.push({ level: "error", code, message });
  const warn = (code: string, message: string) => problems.push({ level: "warning", code, message });

  // Ids: forbidden characters, then uniqueness at every level. The member key
  // is checked too — group `a-b` with member `c` and group `a` with member
  // `b-c` would otherwise share the address `a-b-c`.
  const checkId = (kind: string, id: string) => {
    if (FORBIDDEN.test(id)) error("id-chars", `${kind} id "${id}" must not contain ".", "@" or spaces`);
  };
  checkId("Crew", spec.name);
  const groupIds = new Set<string>();
  const keys = new Set<string>();
  for (const group of spec.groups) {
    checkId("Group", group.id);
    if (groupIds.has(group.id)) error("id-duplicate", `Group id "${group.id}" is used twice`);
    groupIds.add(group.id);
    const memberIds = new Set<string>();
    for (const member of group.members) {
      checkId("Member", member.id);
      if (memberIds.has(member.id)) {
        error("id-duplicate", `Member id "${member.id}" is used twice in group "${group.id}"`);
      } else {
        const key = memberKey(group.id, member.id);
        if (keys.has(key)) error("id-duplicate", `Member address "${key}" is used twice`);
        keys.add(key);
      }
      memberIds.add(member.id);
    }
  }

  // Exactly one lead; a single member is its own lead.
  const allMembers = spec.groups.flatMap((group) => group.members.map((member) => ({ group, member })));
  const explicitLeads = allMembers.filter((entry) => entry.member.lead === true);
  const implicitLead = explicitLeads.length === 0 && allMembers.length === 1;
  if (explicitLeads.length === 0 && !implicitLead) {
    error("lead-missing", "The crew needs exactly one member with lead: true");
  } else if (explicitLeads.length > 1) {
    error(
      "lead-multiple",
      `Only one lead is allowed, found ${explicitLeads.length}: ${explicitLeads
        .map((entry) => memberKey(entry.group.id, entry.member.id))
        .join(", ")}`,
    );
  }

  const members: ResolvedMember[] = allMembers.map(({ group, member }) => {
    const key = memberKey(group.id, member.id);
    const lead = member.lead === true || implicitLead;
    const permissions = member.permissions ?? group.permissions ?? spec.permissions;
    const environment = member.environment ?? group.environment ?? spec.environment;
    return {
      key,
      groupId: group.id,
      memberId: member.id,
      address: `${key}@${spec.name}`,
      lead,
      // Every member names its own provider and model: nothing is inherited, so
      // a member reads the same wherever it is copied to (see inlineExecution).
      provider: member.provider ?? null,
      model: member.model ?? null,
      reasoningLevel: member.reasoningLevel ?? null,
      serviceTier: member.serviceTier ?? null,
      permissions,
      environment,
      placement: placementFor(lead, permissions, environment, spec.environment),
      role: member.role,
      instructions: [spec.instructions, group.instructions, member.instructions].filter(
        (text): text is string => typeof text === "string" && text.trim() !== "",
      ),
      // Crew → group → member, most general first, each name kept once.
      skills: [...new Set([...spec.skills, ...group.skills, ...member.skills])],
      deputy: member.deputy ?? null,
      integrator: member.integrator === true,
      kickoff: member.kickoff ?? spec.kickoff ?? null,
    };
  });

  // Links reference member keys (`orch-lead`), never full addresses.
  for (const link of spec.links) {
    for (const end of [link.from, link.to]) {
      if (!keys.has(end)) error("link-end", `Link ${link.from} → ${link.to} (${link.kind}): "${end}" is not a member`);
    }
  }
  const cycle = findAssignCycle(spec.links, keys);
  if (cycle) error("assign-cycle", `assigns_to forms a cycle: ${cycle.join(" → ")}`);

  // Provider and model belong to the member. A crew- or group-level value is
  // refused rather than inherited; stored files are rewritten by inlineExecution.
  for (const [where, value] of [
    ["crew", spec] as const,
    ...spec.groups.map((group) => [`group ${group.id}`, group] as const),
  ]) {
    const v = value as { provider?: string; model?: string };
    if (v.provider !== undefined || v.model !== undefined) {
      error("execution-not-on-member", `${where}: provider and model go on each member, not on the ${where.split(" ")[0]}`);
    }
  }

  const integrators = members.filter((member) => member.integrator);
  if (integrators.length > 1) {
    error("integrator-multiple", `Only one integrator is allowed per crew, found ${integrators.length}: ${integrators.map((m) => m.key).join(", ")}`);
  }

  for (const member of members) {
    // The role used to decide this; a crew file written that way would now
    // silently lose its integrator, so say so.
    if (!member.integrator && /\bintegrator\b/i.test(member.role)) {
      warn("integrator-role-text", `${member.key}: the role mentions "integrator" but integrator: true is not set, so this member cannot merge`);
    }
    if (member.deputy !== null && !keys.has(member.deputy)) {
      error("deputy", `${member.key}: deputy "${member.deputy}" is not a member`);
    }
    // Without both values BB picks the project default without saying so —
    // exactly the silent fallback §6 warns about.
    if (member.provider === null || member.model === null) {
      error("execution-missing", `${member.key}: provider and model must both be set on the member itself`);
    }
    if (member.permissions === "full" && options.confirmFull !== true) {
      error("full-unconfirmed", `${member.key} runs with permissions: full — confirm with --confirm-full`);
    }
    const text = buildInstructions(spec, member);
    if (text.length > INSTRUCTION_LIMIT) {
      error(
        "instructions-too-long",
        `${member.key}: role and inherited instructions take ${text.length} characters, the limit is ${INSTRUCTION_LIMIT}`,
      );
    }
  }

  const catalog = options.catalog;
  if (catalog) {
    for (const member of members) {
      if (member.provider === null) continue;
      const models = catalog.providers.get(member.provider);
      if (!models) {
        warn("unknown-provider", `${member.key}: provider "${member.provider}" is not offered here`);
      } else if (member.model !== null && !models.has(member.model)) {
        warn("unknown-model", `${member.key}: model "${member.model}" is not in the catalogue of "${member.provider}"`);
      }
    }
  }

  const skillsCatalog = options.skills;
  if (skillsCatalog) {
    for (const member of members) {
      for (const name of member.skills) {
        if (!skillsCatalog.names.has(name)) {
          warn("unknown-skill", `${member.key}: skill "${name}" is not known here`);
        }
      }
    }
  }

  if (spec.waitsFor.length > 0 && !spec.task) {
    warn("waits-without-task", "waitsFor is set but task is not: the wartet-auf label has no task to go on");
  }
  for (const dependency of spec.waitsFor) {
    if (spec.task && dependency.task === spec.task) error("waits-for-self", `waitsFor names the crew's own task ${spec.task}`);
  }

  const sharedWriters = members.filter(
    (member) => member.placement.kind !== "own-worktree" && WRITING_PERMISSIONS.has(member.permissions),
  );
  if (sharedWriters.length > 1) {
    warn(
      "shared-writers",
      `${sharedWriters.length} writing members share one environment: ${sharedWriters.map((m) => m.key).join(", ")}`,
    );
  }

  return { spec, members: topoOrder(members, spec.links), problems };
}

/** §3.2 "Umgebung": writers get their own worktree, readers share the crew's. */
export function placementFor(
  lead: boolean,
  permissions: Permission,
  environment: EnvironmentSpec,
  crewEnvironment: EnvironmentSpec,
): Placement {
  if (environment.type === "host") return { kind: "host", hostId: environment.hostId };
  if (lead) {
    return {
      kind: "crew-root",
      workspace: crewEnvironment.type === "reuse" ? "project-default" : "managed-worktree",
    };
  }
  if (environment.type === "worktree") return { kind: "own-worktree" };
  if (environment.type === "reuse") return { kind: "shared" };
  return WRITING_PERMISSIONS.has(permissions) ? { kind: "own-worktree" } : { kind: "shared" };
}

/** The durable per-thread instruction (E2 hands it to `agents.configure`). */
export function buildInstructions(spec: Pick<CrewSpec, "name" | "summary">, member: ResolvedMember): string {
  return [
    `You are ${member.address}${member.lead ? ", the lead of this crew" : ""}.`,
    `Crew: ${spec.name}${spec.summary ? ` — ${spec.summary}` : ""}`,
    member.role ? `Role: ${member.role}` : "",
    ...member.instructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function findAssignCycle(links: CrewSpec["links"], keys: Set<string>): string[] | null {
  const edges = new Map<string, string[]>();
  for (const link of links) {
    if (link.kind !== "assigns_to" || !keys.has(link.from) || !keys.has(link.to)) continue;
    edges.set(link.from, [...(edges.get(link.from) ?? []), link.to]);
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "visiting") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of edges.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

/**
 * Lead first, then along `assigns_to` breadth-first, then the rest in file
 * order. Every other thread nests under the lead, so the lead must exist
 * before anyone else is spawned.
 */
export function topoOrder(members: ResolvedMember[], links: CrewSpec["links"]): ResolvedMember[] {
  const byKey = new Map(members.map((member) => [member.key, member]));
  const ordered: ResolvedMember[] = [];
  const seen = new Set<string>();
  const push = (member: ResolvedMember | undefined) => {
    if (!member || seen.has(member.key)) return;
    seen.add(member.key);
    ordered.push(member);
  };
  const lead = members.find((member) => member.lead);
  push(lead);
  const queue = lead ? [lead.key] : [];
  while (queue.length > 0) {
    const from = queue.shift()!;
    for (const link of links) {
      if (link.kind === "assigns_to" && link.from === from && !seen.has(link.to)) {
        push(byKey.get(link.to));
        queue.push(link.to);
      }
    }
  }
  for (const member of members) push(member);
  return ordered;
}

/**
 * Move crew- and group-level provider/model onto every member that does not
 * name its own, and drop them from crew and groups. Returns the rewritten
 * YAML, or null when there was nothing to change. Member keys are put in the
 * order id, lead, provider, model, then the rest; comments survive because
 * the document is edited in place.
 */
export function inlineExecution(text: string): string | null {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0 || !YAML.isMap(doc.contents)) return null;
  const root = doc.contents;
  const keys = ["provider", "model"] as const;
  const crewLevel = Object.fromEntries(keys.map((key) => [key, root.get(key)])) as Record<string, unknown>;
  let changed = keys.some((key) => root.has(key));
  const groups = root.get("groups", true);
  if (YAML.isSeq(groups)) {
    for (const group of groups.items) {
      if (!YAML.isMap(group)) continue;
      const groupLevel = Object.fromEntries(keys.map((key) => [key, group.get(key) ?? crewLevel[key]])) as Record<string, unknown>;
      if (keys.some((key) => group.has(key))) changed = true;
      const members = group.get("members", true);
      if (YAML.isSeq(members)) {
        for (const member of members.items) {
          if (!YAML.isMap(member)) continue;
          for (const key of keys) {
            if (!member.has(key) && groupLevel[key] !== undefined) {
              member.set(key, groupLevel[key]);
              changed = true;
            }
          }
          // Read a member top-down: who (id, lead), then what runs it.
          const rank = (item: (typeof member.items)[number]) => {
            const key = YAML.isScalar(item.key) ? item.key.value : item.key;
            const index = ["id", "lead", "provider", "model", "reasoningLevel", "serviceTier"].indexOf(String(key));
            return index === -1 ? 6 : index;
          };
          const sorted = [...member.items].sort((a, b) => rank(a) - rank(b));
          if (sorted.some((item, i) => item !== member.items[i])) {
            member.items = sorted;
            changed = true;
          }
        }
      }
      for (const key of keys) group.delete(key);
    }
  }
  for (const key of keys) root.delete(key);
  return changed ? doc.toString() : null;
}
