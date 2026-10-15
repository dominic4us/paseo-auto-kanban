// Behavior reproduced from Paseo v0.8.0 (Apache-2.0):
// packages/app/src/styles/identity-colors.ts, utils/project-display-name.ts,
// projects/workspace-structure.ts and components/{project-icon-view,sidebar/project-leading-visual}.tsx.
// https://github.com/getpaseo/paseo/tree/v0.8.0/packages/app/src
// Palette constants live in palette.ts; custom image bytes are not in the public directory DTO.
export function projectColorIndex(key: string): number {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 10;
}
export function projectInitial(displayName: string): string {
  const trimmed = displayName.trim();
  const last = trimmed.split('/').filter(Boolean).pop() ?? trimmed;
  return last.charAt(0).toUpperCase();
}
export function projectViewKeys(hostId: string, projects: readonly { projectId: string; projectKey?: string | null | undefined }[]) {
  const counts = new Map<string, number>();
  const allocated = new Set<string>();
  for (const p of projects) if (p.projectKey) {
    counts.set(p.projectKey, (counts.get(p.projectKey) ?? 0) + 1); allocated.add(p.projectKey);
  }
  const result = new Map<string, string>();
  for (const p of projects) {
    if (p.projectKey && counts.get(p.projectKey) === 1) { result.set(p.projectId, p.projectKey); continue; }
    let key = JSON.stringify([hostId, p.projectId]), index = 0;
    while (allocated.has(key)) key = JSON.stringify(['placement', hostId, p.projectId, index++]);
    allocated.add(key); result.set(p.projectId, key);
  }
  return result;
}
