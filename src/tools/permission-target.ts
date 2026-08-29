import { resolve, sep } from "node:path";

export function resolveToolPath(cwd: string, ...parts: string[]): string {
  return resolve(cwd, ...parts);
}

export function normalizePermissionPath(cwd: string, ...parts: string[]): string {
  const normalized = resolveToolPath(cwd, ...parts);
  return sep === "/" ? normalized : normalized.split(sep).join("/");
}
