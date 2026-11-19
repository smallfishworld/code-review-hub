import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { isAbsolute } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

const PATHEXT = (() => {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.toLowerCase())
    .filter(Boolean);
  return exts.length ? exts : ['.com', '.exe', '.bat', '.cmd'];
})();

/**
 * Cross-platform PATH lookup for an executable.
 * Resolves the absolute path of the first matching executable, or null.
 *
 * On Windows, a bare name is matched against PATHEXT (so `ocr` finds
 * `ocr.cmd` from an npm install); an absolute/relative path with an
 * extension is checked directly.
 */
export async function which(
  command: string,
  pathEnv: string | undefined = process.env.PATH
): Promise<string | null> {
  return (await locateCommand(command, pathEnv)).path;
}

/**
 * Like which(), but also reports a file that exists yet is not executable.
 * Lets the dependency probe distinguish "missing" from "present but broken",
 * which is the difference between "install svn" and "fix your PATH entry".
 */
export async function locateCommand(
  command: string,
  pathEnv: string | undefined = process.env.PATH
): Promise<{ path: string | null; found: boolean }> {
  if (!command) return { path: null, found: false };

  const hasPathSep = command.includes('/') || command.includes('\\');
  const bases = hasPathSep || isAbsolute(command)
    ? [command]
    : (pathEnv ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, command));

  let found = false;
  for (const base of bases) {
    for (const candidate of extensionCandidates(base)) {
      const state = await fileState(candidate);
      if (state === 'executable') return { path: candidate, found: true };
      if (state === 'present') found = true;
    }
  }
  return { path: null, found };
}

function extensionCandidates(base: string): string[] {
  if (!IS_WINDOWS) return [base];
  const lower = base.toLowerCase();
  const hasExt = PATHEXT.some((e) => lower.endsWith(e));
  // Prefer PATHEXT matches: npm installs both `ocr` (a POSIX shell script)
  // and `ocr.cmd`; CreateProcess cannot execute the extensionless one, so
  // resolving to it would report a false "found but broken".
  return hasExt ? [base] : [...PATHEXT.map((e) => base + e), base];
}

async function fileState(p: string): Promise<'executable' | 'present' | null> {
  try {
    // Must be a regular file (not a directory): Windows system dirs like
    // C:\Windows\OCR otherwise shadow commands named "ocr".
    const st = await stat(p);
    if (!st.isFile()) return null;
    await access(p, constants.F_OK | (IS_WINDOWS ? 0 : constants.X_OK));
    return 'executable';
  } catch (err) {
    // EACCES on POSIX = the file exists but lacks the execute bit.
    if ((err as NodeJS.ErrnoException).code === 'EACCES') return 'present';
    return null;
  }
}

async function isExecutableFile(p: string): Promise<boolean> {
  return (await fileState(p)) === 'executable';
}

export { isExecutableFile };
