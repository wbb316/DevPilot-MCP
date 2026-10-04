import { expect } from 'vitest';

import type { ProjectProfile } from '../../src/types/workspace';

const LANGUAGES = ['Python', 'Java', 'Kotlin', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'C', 'C++'];
const PROJECT_TYPES = ['PyTorch', 'SpringBoot', 'Node', 'React', 'Vue', 'Next.js', 'Express', 'FastAPI', 'Flask', 'Django', 'Python', 'Java', 'TypeScript', 'Unknown'];
const BUILD_SYSTEMS = ['maven', 'gradle', 'npm', 'pnpm', 'yarn', 'pip', 'poetry', 'none'];
const TEST_FRAMEWORKS = ['pytest', 'unittest', 'jest', 'vitest', 'junit', 'none'];

/** Structural contract from docs/DATA-MODEL.md §3 — every detected profile must satisfy it. */
export function projectProfileShape(profile: ProjectProfile): void {
  expect(typeof profile.name).toBe('string');
  expect(profile.name.length).toBeGreaterThan(0);
  expect(typeof profile.root).toBe('string');
  expect(Array.isArray(profile.languages)).toBe(true);
  for (const language of profile.languages) expect(LANGUAGES).toContain(language);

  expect(PROJECT_TYPES).toContain(profile.projectType);
  if (profile.buildSystem !== undefined) expect(BUILD_SYSTEMS).toContain(profile.buildSystem);
  if (profile.testFramework !== undefined) expect(TEST_FRAMEWORKS).toContain(profile.testFramework);

  for (const list of [profile.entrypoints, profile.markers, profile.sourceDirs, profile.testDirs, profile.configDirs]) {
    expect(Array.isArray(list)).toBe(true);
    for (const entry of list) {
      expect(typeof entry).toBe('string');
      expect(entry.length).toBeGreaterThan(0);
      expect(entry.startsWith(profile.root)).toBe(false);
      expect(entry.includes('\\')).toBe(false);
    }
  }

  expect(new Date(profile.detectedAt).toString()).not.toBe('Invalid Date');
  expect(profile.candidates).toBeTypeOf('object');
}
