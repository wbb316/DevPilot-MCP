import { describe, expect, it } from 'vitest';

import { extractLocations } from '../../src/diagnose/location';

/**
 * Location extraction across the frame families DevPilot has to read in the wild.
 *
 * The Windows cases come straight from a real acceptance run (Phase 10): a Maven Surefire log
 * whose first frame is JUnit's own `AssertionFailureBuilder.java`, and a `node --test` log that
 * prints a percent-encoded `file:///` URL for a profile under `C:\Users\王贝波\…`.
 */

const WINDOWS = process.platform === 'win32';
const WIN_ROOT = 'C:\\proj\\demo';
const CJK_ROOT = 'C:\\Users\\王贝波\\AppData\\Local\\Temp\\demo';

describe('extractLocations', () => {
  it('reads a python traceback frame and counts library frames as external', () => {
    const text = [
      'Traceback (most recent call last):',
      '  File "C:\\proj\\demo\\train.py", line 214, in forward',
      '  File "C:\\proj\\demo\\.venv\\Lib\\site-packages\\torch\\nn.py", line 5, in call',
      'RuntimeError: boom',
    ].join('\n');
    const scan = extractLocations(text, WIN_ROOT, 8, { fileExists: () => true });
    expect(scan.locations[0]?.path).toBe('train.py');
    expect(scan.locations[0]?.line).toBe(214);
    expect(scan.locations.map((location) => location.path)).not.toContain('nn.py');
    expect(scan.externalFrames).toBe(1);
  });

  it('prefers a verified frame over a bare JVM frame when a resolver is supplied', () => {
    const text = [
      '[ERROR] com.example.TitleLengthTest.lengthOfTitleRejectsNullInput -- Time elapsed: 0.023 s <<< FAILURE!',
      '[ERROR]   at org.junit.jupiter.api.AssertThrows.assertThrows(AssertThrows.java:67)',
      '[ERROR]   at org.junit.jupiter.api.AssertThrows.assertThrows(AssertThrows.java:35)',
      '[ERROR]   at com.example.TitleLengthTest.lengthOfTitleRejectsNullInput(TitleLengthTest.java:13)',
      '[ERROR]   at com.example.UserService.lengthOfTitle(UserService.java:15)',
    ].join('\n');

    const resolved = extractLocations(text, WIN_ROOT, 5, {
      resolveBareName: (name) =>
        name === 'TitleLengthTest.java'
          ? 'src/test/java/com/example/TitleLengthTest.java'
          : name === 'UserService.java'
            ? 'src/main/java/com/example/UserService.java'
            : undefined,
    });

    // Before Phase 10 the first location was AssertThrows.java:67 — JUnit internals instead of
    // the project's own test.
    expect(resolved.locations.slice(0, 2).map((location) => location.path)).toEqual([
      'src/test/java/com/example/TitleLengthTest.java',
      'src/main/java/com/example/UserService.java',
    ]);
    expect(resolved.locations[0]?.line).toBe(13);
    expect(resolved.unresolvedFrames).toBe(2);
    // Unresolvable frames are kept, but only after every workspace location.
    const firstUnresolved = resolved.locations.findIndex((location) => location.path === 'AssertThrows.java');
    expect(firstUnresolved).toBeGreaterThan(1);
  });

  it('keeps bare frames in order when nothing can resolve them (previous behaviour)', () => {
    const text = '[ERROR]   at org.junit.jupiter.api.AssertThrows.assertThrows(AssertThrows.java:67)';
    const scan = extractLocations(text, WIN_ROOT);
    expect(scan.locations[0]?.path).toBe('AssertThrows.java');
    expect(scan.unresolvedFrames).toBe(1);
  });

  it('sinks an unverified relative frame below a verified one', () => {
    const text = 'error at src/ghost.ts:3:1 while src/app.ts:10:5 ran';
    const scan = extractLocations(text, WIN_ROOT, 8, {
      fileExists: (relative) => relative === 'src/app.ts',
    });
    expect(scan.locations.map((location) => location.path)).toEqual(['src/app.ts', 'src/ghost.ts']);
    expect(scan.unresolvedFrames).toBe(1);
  });

  it.runIf(WINDOWS)('decodes a percent-encoded file URL and does not bite off its tail', () => {
    const text =
      '    TestContext.<anonymous> (file:///C:/Users/%E7%8E%8B%E8%B4%9D%E6%B3%A2/AppData/Local/Temp/demo/test/x.test.js:7:10)';
    const scan = extractLocations(text, CJK_ROOT, 8, { fileExists: () => true });
    expect(scan.locations[0]).toEqual({ path: 'test/x.test.js', line: 7, column: 10 });
    // The ASCII-only character class used to match `A2/AppData/…` after the percent escapes.
    expect(scan.locations.map((location) => location.path).join(',')).not.toContain('AppData');
  });

  it.runIf(WINDOWS)('keeps a non-ASCII absolute path from node:test TAP output', () => {
    const text = "  location: 'C:\\Users\\王贝波\\AppData\\Local\\Temp\\demo\\test\\x.test.js:6:1'";
    const scan = extractLocations(text, CJK_ROOT, 8, { fileExists: () => true });
    expect(scan.locations[0]).toEqual({ path: 'test/x.test.js', line: 6, column: 1 });
  });
});
