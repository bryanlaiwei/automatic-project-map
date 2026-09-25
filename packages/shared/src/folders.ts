// Compare folder paths by their parts, not by a raw string prefix.
// "/Projects/my-app-copy" must not match the root "/Projects/my-app".
export function normalizeAbsolutePath(input: string): string | null {
  if (!input.startsWith("/")) {
    return null;
  }

  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return `/${parts.join("/")}`;
}

export function folderMatchesRoot(workingFolder: string, selectedRoot: string): boolean {
  const folder = normalizeAbsolutePath(workingFolder);
  const root = normalizeAbsolutePath(selectedRoot);
  if (folder === null || root === null) {
    return false;
  }
  return folder === root || folder.startsWith(`${root}/`);
}

export function matchingRoot(workingFolder: string, selectedRoots: string[]): string | null {
  const matches = selectedRoots.filter((root) => folderMatchesRoot(workingFolder, root));
  if (matches.length === 0) {
    return null;
  }

  // If the user selected both a parent and a child, keep the longer root.
  // The activity is still one match, so it is not stored twice.
  return matches.reduce((best, root) => (root.length > best.length ? root : best));
}
