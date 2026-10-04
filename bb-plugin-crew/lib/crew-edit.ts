// Edits behind the fullscreen crew editor (BBP-80). Same contract as
// crewfile.ts: YAML text in, YAML text out, worked on the YAML document so
// comments and the human's order survive. Validation stays with validateCrew.
import YAML, { isMap, isSeq, type Document, type YAMLMap } from "yaml";
import { addMemberToFile, CrewFileEditError } from "./crewfile";
import { memberKey, type LinkKind } from "./spec";

export type EditorMember = {
  key: string;
  group: string;
  id: string;
  lead: boolean;
  role: string;
  provider: string;
  model: string;
  reasoningLevel: string;
  serviceTier: string;
  permissions: string;
  environment: string;
  skills: string[];
};
export type EditorLink = { from: string; to: string; kind: string };
export type EditorModel = {
  crew: { name: string; baseBranch: string; instructions: string };
  groups: string[];
  members: EditorMember[];
  links: EditorLink[];
};

const ID = /^[A-Za-z0-9][\w-]*$/;
const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));

function parse(yaml: string): Document {
  const doc = YAML.parseDocument(yaml);
  if (doc.errors.length > 0 || !isMap(doc.contents)) throw new CrewFileEditError("The crew file does not parse.");
  return doc;
}

const write = (doc: Document) => doc.toString({ lineWidth: 0 });

export function editorModel(yaml: string): EditorModel | null {
  const doc = YAML.parseDocument(yaml);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const root = doc.contents as YAMLMap;
  const groups: string[] = [];
  const members: EditorMember[] = [];
  const list = root.get("groups", true);
  if (isSeq(list)) {
    for (const node of list.items) {
      if (!isMap(node)) continue;
      const group = str((node as YAMLMap).get("id"));
      groups.push(group);
      const entries = (node as YAMLMap).get("members", true);
      if (!isSeq(entries)) continue;
      for (const entry of entries.items) {
        if (!isMap(entry)) continue;
        const m = entry as YAMLMap;
        const skills = m.get("skills", true);
        const environment = m.get("environment");
        members.push({
          key: memberKey(group, str(m.get("id"))),
          group,
          id: str(m.get("id")),
          lead: m.get("lead") === true,
          role: str(m.get("role")),
          provider: str(m.get("provider")),
          model: str(m.get("model")),
          reasoningLevel: str(m.get("reasoningLevel")),
          serviceTier: str(m.get("serviceTier")),
          permissions: str(m.get("permissions")),
          environment: isMap(environment) ? str((environment as YAMLMap).get("type")) : str(environment),
          skills: isSeq(skills) ? skills.items.map((item) => str(YAML.isScalar(item) ? item.value : item)) : [],
        });
      }
    }
  }
  const links: EditorLink[] = [];
  const linkList = root.get("links", true);
  if (isSeq(linkList)) {
    for (const node of linkList.items) {
      if (!isMap(node)) continue;
      const link = node as YAMLMap;
      links.push({ from: str(link.get("from")), to: str(link.get("to")), kind: str(link.get("kind")) });
    }
  }
  return {
    crew: { name: str(root.get("name")), baseBranch: str(root.get("baseBranch")) || "main", instructions: str(root.get("instructions")) },
    groups,
    members,
    links,
  };
}

/** The YAML node of one member, found by its key (`group-id`). */
function memberNode(doc: Document, key: string): YAMLMap {
  const groups = doc.get("groups", true);
  if (isSeq(groups)) {
    for (const group of groups.items) {
      if (!isMap(group)) continue;
      const members = (group as YAMLMap).get("members", true);
      if (!isSeq(members)) continue;
      for (const member of members.items) {
        if (isMap(member) && memberKey(str((group as YAMLMap).get("id")), str((member as YAMLMap).get("id"))) === key) return member as YAMLMap;
      }
    }
  }
  throw new CrewFileEditError(`There is no member ${key} in the crew file.`);
}

/** Set one scalar on a member; "" removes the key so the crew-level default applies. */
export function setMemberValue(yaml: string, key: string, field: string, value: string): string {
  const doc = parse(yaml);
  const member = memberNode(doc, key);
  if (value === "") member.delete(field);
  else member.set(field, value);
  return write(doc);
}

/** What BB's provider/model picker chose; level and tier are dropped when the picker returns none. */
export function setMemberExecution(
  yaml: string,
  key: string,
  value: { providerId: string; model: string; reasoningLevel?: string; serviceTier?: string },
): string {
  const doc = parse(yaml);
  const member = memberNode(doc, key);
  member.set("provider", value.providerId);
  member.set("model", value.model);
  for (const field of ["reasoningLevel", "serviceTier"] as const) {
    if (value[field]) member.set(field, value[field]);
    else member.delete(field);
  }
  return write(doc);
}

export function setMemberSkills(yaml: string, key: string, skills: readonly string[]): string {
  const doc = parse(yaml);
  const member = memberNode(doc, key);
  const clean = [...new Set(skills.map((skill) => skill.trim()).filter(Boolean))];
  if (clean.length === 0) member.delete("skills");
  else member.set("skills", doc.createNode(clean));
  return write(doc);
}

/** Rename a member within its group; links and deputies that name it follow. */
export function renameMemberInFile(yaml: string, key: string, id: string): string {
  if (!ID.test(id)) throw new CrewFileEditError("Member ids are letters, digits, '-' and '_' only.");
  const doc = parse(yaml);
  const member = memberNode(doc, key);
  const group = key.slice(0, key.length - str(member.get("id")).length - 1);
  const next = memberKey(group, id);
  if (next === key) return yaml;
  if (editorModel(yaml)!.members.some((entry) => entry.key === next)) throw new CrewFileEditError(`${next} is already in the crew file.`);
  member.set("id", id);
  const links = doc.get("links", true);
  if (isSeq(links)) {
    for (const node of links.items) {
      if (!isMap(node)) continue;
      for (const end of ["from", "to"]) if (str((node as YAMLMap).get(end)) === key) (node as YAMLMap).set(end, next);
    }
  }
  const groups = doc.get("groups", true);
  if (isSeq(groups)) {
    for (const g of groups.items) {
      const members = isMap(g) ? (g as YAMLMap).get("members", true) : null;
      if (!isSeq(members)) continue;
      for (const m of members.items) if (isMap(m) && (m as YAMLMap).get("deputy") === key) (m as YAMLMap).set("deputy", next);
    }
  }
  return write(doc);
}

export function addLinkToFile(yaml: string, from: string, to: string, kind: LinkKind): string {
  if (from === to) throw new CrewFileEditError("A member cannot link to itself.");
  const model = editorModel(yaml);
  if (model?.links.some((link) => link.from === from && link.to === to && link.kind === kind)) return yaml;
  const doc = parse(yaml);
  const links = doc.get("links", true);
  const entry = doc.createNode({ from, to, kind });
  if (isSeq(links)) links.add(entry);
  else doc.set("links", doc.createNode([{ from, to, kind }]));
  return write(doc);
}

export function removeLinkFromFile(yaml: string, index: number): string {
  const doc = parse(yaml);
  const links = doc.get("links", true);
  if (!isSeq(links) || !links.items[index]) throw new CrewFileEditError("There is no such link.");
  links.items.splice(index, 1);
  if (links.items.length === 0) doc.delete("links");
  return write(doc);
}

/** "+ Member" / "+ Group": a group needs a member, so both add one. */
export function addGroupToFile(yaml: string, group: string, id: string): string {
  return addMemberToFile(yaml, { group, id });
}

/** A free member id in the group: "member", then "member2", "member3", … */
export function nextMemberId(model: EditorModel, group: string): string {
  const taken = new Set(model.members.filter((member) => member.group === group).map((member) => member.id));
  let id = "member";
  for (let n = 2; taken.has(id); n++) id = `member${n}`;
  return id;
}

export function setCrewValue(yaml: string, key: "baseBranch" | "instructions", value: string): string {
  const doc = parse(yaml);
  if (value === "") doc.delete(key);
  else doc.set(key, value);
  return write(doc);
}
