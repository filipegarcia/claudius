import { isAbsolute, resolve, sep } from "node:path";

/**
 * Path-injection barriers used at the boundary between HTTP input and
 * `fs.*` calls. Two flavors, one for each shape of "trust" we have:
 *
 *  - `assertWithin(base, child)` — the operation MUST stay inside `base`
 *    (e.g. writing to `<projectCwd>/.claude/agents/<name>.md`). Resolves
 *    both sides and rejects anything that escapes `base`. This is the
 *    barrier CodeQL's `js/path-injection` recognizes.
 *
 *  - `assertAbsoluteUserPath(input)` — the user is intentionally choosing
 *    a path on their machine (e.g. workspace `rootPath`). We can't pin a
 *    base, so the best we can do is reject obvious tampering (null bytes,
 *    relative paths) and return a normalized absolute path.
 *
 * Both throw on violation with a `path-injection` flavored message so the
 * surrounding route handler can map them to a 400.
 */

export class PathInjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathInjectionError";
  }
}

/**
 * Returns the resolved absolute path of `child` (interpreted relative to
 * `base` if not already absolute) and asserts the result is `base` or a
 * descendant of `base`. Throws `PathInjectionError` otherwise.
 */
export function assertWithin(base: string, child: string): string {
  if (typeof base !== "string" || base.length === 0) {
    throw new PathInjectionError("invalid base path");
  }
  if (typeof child !== "string" || child.length === 0) {
    throw new PathInjectionError("invalid child path");
  }
  if (base.indexOf("\0") !== -1 || child.indexOf("\0") !== -1) {
    throw new PathInjectionError("null byte in path");
  }
  const resolvedBase = resolve(base);
  const resolvedChild = resolve(resolvedBase, child);
  if (
    resolvedChild !== resolvedBase &&
    !resolvedChild.startsWith(resolvedBase + sep)
  ) {
    throw new PathInjectionError("path escapes base directory");
  }
  return resolvedChild;
}

/**
 * Validates a user-supplied absolute path (e.g. a workspace `rootPath`).
 * The user is intentionally choosing this location, so we can't constrain
 * to a base — but we still reject relative paths and null bytes, and
 * return the normalized form. Throws `PathInjectionError` on violation.
 */
export function assertAbsoluteUserPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathInjectionError("invalid path");
  }
  if (input.indexOf("\0") !== -1) {
    throw new PathInjectionError("null byte in path");
  }
  if (!isAbsolute(input)) {
    throw new PathInjectionError("path must be absolute");
  }
  return resolve(input);
}
