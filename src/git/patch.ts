import { unquoteGitPath } from './diff-analyzer.js';

/**
 * Which paths a patch actually carries. `rollback_checkpoint` needs this to stay honest:
 * a path that has no hunk in the patch cannot be "restored", however successful `git apply`
 * reports itself for an empty selection.
 */

export function parsePatchPaths(patchText: string): Set<string> {
  const paths = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (.+) (.+)$/.exec(line);
      if (match === null) continue;
      const target = unquoteGitPath(match[2] as string).replace(/^b\//, '');
      if (target !== '/dev/null') paths.add(target.split('\\').join('/'));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw === '/dev/null') continue;
      const target = unquoteGitPath(raw).replace(/^b\//, '');
      paths.add(target.split('\\').join('/'));
    }
  }
  return paths;
}
