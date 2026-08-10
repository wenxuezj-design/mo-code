import { resolve, sep } from "node:path";

export function normalizePermissionPath(cwd: string, ...parts: string[]): string {
  const normalized = resolve(cwd, ...parts);
  return sep === "/" ? normalized : normalized.split(sep).join("/");
}
