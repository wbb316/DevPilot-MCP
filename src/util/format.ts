/** Small formatting helpers shared by tools and the CLI (output is for humans and agents). */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** `python 12, java 4` — biggest first, capped so a summary line stays a line. */
export function topLanguages(
  languages: Record<string, { files: number; bytes: number }>,
  limit = 4,
): string {
  const entries = Object.entries(languages)
    .filter(([, stats]) => stats.files > 0)
    .sort((a, b) => (b[1].files === a[1].files ? (a[0] < b[0] ? -1 : 1) : b[1].files - a[1].files))
    .slice(0, limit);
  return entries.map(([name, stats]) => `${name} ${stats.files}`).join(', ');
}
