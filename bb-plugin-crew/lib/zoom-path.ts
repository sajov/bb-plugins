// BBP-83: the Crews view is one canvas you zoom into — all projects, one
// project, one crew, one agent. The path is the only state that says where
// you are; the breadcrumb and Esc both read it.

export type ZoomPath = { projectId?: string; crew?: string; member?: string };
export type ZoomLevel = 0 | 1 | 2 | 3;

export function zoomLevel(path: ZoomPath): ZoomLevel {
  if (path.projectId === undefined) return 0;
  if (path.crew === undefined) return 1;
  if (path.member === undefined) return 2;
  return 3;
}

/** One level up; the top stays the top. */
export function zoomOut(path: ZoomPath): ZoomPath {
  if (path.member !== undefined) return { projectId: path.projectId, crew: path.crew };
  if (path.crew !== undefined) return { projectId: path.projectId };
  return {};
}

export type Crumb = { label: string; path: ZoomPath };

export function breadcrumb(path: ZoomPath, projectName: (id: string) => string): Crumb[] {
  const crumbs: Crumb[] = [{ label: "All", path: {} }];
  if (path.projectId === undefined) return crumbs;
  crumbs.push({ label: projectName(path.projectId), path: { projectId: path.projectId } });
  if (path.crew === undefined) return crumbs;
  crumbs.push({ label: path.crew, path: { projectId: path.projectId, crew: path.crew } });
  if (path.member === undefined) return crumbs;
  crumbs.push({ label: path.member, path: { projectId: path.projectId, crew: path.crew, member: path.member } });
  return crumbs;
}
