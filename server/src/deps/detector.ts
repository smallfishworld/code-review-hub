import { spawn } from 'node:child_process';
import { locateCommand } from './which.js';
import { bindProcessAbort } from '../vcs/processAbort.js';

export interface DependencyResult {
  /** command name: svn | git | ocr */
  command: string;
  /** whether the binary was found on PATH */
  found: boolean;
  /** whether it executed successfully */
  executable: boolean;
  /** first line of `--version` output, if available */
  version?: string;
  /** error description when not found / not executable */
  error?: string;
  /** minimum supported version, when the tool has one */
  minVersion?: string;
  /** human note shown in the console (e.g. SVN version requirement) */
  note?: string;
  /** official download / package URL */
  officialUrl?: string;
  /**
   * Whether this dependency is required unconditionally. svn/git are
   * conditional (only needed when a repo of that type is configured);
   * ocr is always required for reviews.
   */
  conditional: boolean;
}

export interface DependencyReport {
  results: DependencyResult[];
  /** true when every unconditional dependency is found and executable */
  ok: boolean;
}

const WINDOWS = process.platform === 'win32';

/** Commands the platform knows how to invoke, and their nature. */
export const DEPENDENCY_SPECS: Record<
  string,
  { conditional: boolean; minVersion?: string; note?: string; officialUrl: string }
> = {
  ocr: {
    conditional: false,
    // SVN single-revision reviews (`ocr review --commit <rev>` on an SVN
    // working copy) landed in the 1.12.13 fork; older builds only support
    // SVN workspace mode.
    minVersion: '1.12.13',
    note: 'SVN 单节点评审需要 open-code-review-svn >= 1.12.13',
    officialUrl: 'https://www.npmjs.com/package/@smallfishworld/open-code-review-svn',
  },
  // ocr's SVN workspace mode runs `svn info --show-item`, which needs 1.9+.
  svn: {
    conditional: true,
    minVersion: '1.9',
    note: 'ocr 的 SVN 工作副本模式需要 SVN >= 1.9',
    officialUrl: 'https://subversion.apache.org/packages.html',
  },
  git: {
    conditional: true,
    officialUrl: 'https://git-scm.com/downloads',
  },
};

/** Extract the first `x.y[.z]` from a version line. */
export function parseVersion(text: string | undefined): number[] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** Compare dotted versions; returns <0, 0, >0. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Probe a single `<cmd> --version` invocation.
 * On Windows, spawn without shell: npm-installed CLIs (.cmd shims) are
 * resolved by which() against PATHEXT.
 */
export async function probeDependency(
  command: string,
  conditional: boolean,
  timeoutMs = 10_000,
  minVersion?: string,
  signal?: AbortSignal
): Promise<DependencyResult> {
  signal?.throwIfAborted();
  const located = await locateCommand(command);
  signal?.throwIfAborted();
  const resolved = located.path;
  if (!resolved) {
    return {
      command,
      found: located.found,
      executable: false,
      conditional,
      error: located.found
        ? `command "${command}" exists on PATH but is not executable`
        : `command "${command}" not found on PATH`,
    };
  }
  return new Promise<DependencyResult>((resolve) => {
    let settled = false;
    const done = (r: DependencyResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        unbind();
        resolve(r);
      }
    };
    // Windows cannot spawn .cmd/.bat shims (npm-installed CLIs such as ocr)
    // without a shell: CreateProcess only runs PE executables.
    const needsShell = WINDOWS && /\.(cmd|bat)$/i.test(resolved);
    const child = spawn(resolved, ['--version'], {
      windowsHide: true,
      shell: needsShell,
      detached: Boolean(signal) && !WINDOWS,
    });
    const unbind = bindProcessAbort(child, signal);
    const timer = setTimeout(() => {
      child.kill();
      done({
        command,
        found: true,
        executable: false,
        conditional,
        error: 'timed out while executing --version',
      });
    }, timeoutMs);

    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 4096) out += d.toString('utf8');
    });
    child.stderr.on('data', () => {
      /* ignore stderr for version probing */
    });
    child.on('error', (err) => {
      done({
        command,
        found: true,
        executable: false,
        conditional,
        error: `failed to execute: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      if (code === 0) {
        const version = out.split(/\r?\n/, 1)[0]?.trim() || undefined;
        const actual = parseVersion(version);
        const required = parseVersion(minVersion);
        if (required && actual && compareVersions(actual, required) < 0) {
          done({
            command,
            found: true,
            executable: false,
            conditional,
            version,
            error: `版本过低：需要 >= ${minVersion}，当前 ${actual.join('.')}`,
          });
          return;
        }
        done({ command, found: true, executable: true, conditional, version });
      } else {
        done({
          command,
          found: true,
          executable: false,
          conditional,
          error: `--version exited with code ${code}`,
        });
      }
    });
  });
}

/**
 * Probe all known dependencies and produce a startup report.
 */
export async function checkDependencies(): Promise<DependencyReport> {
  const entries = Object.entries(DEPENDENCY_SPECS);
  const results = await Promise.all(
    entries.map(([command, spec]) =>
      probeDependency(command, spec.conditional, 10_000, spec.minVersion)
    )
  );
  // Attach the spec's note & official URL so the console can explain requirements and repair paths.
  for (const r of results) {
    const spec = DEPENDENCY_SPECS[r.command];
    if (spec?.minVersion) r.minVersion = spec.minVersion;
    if (spec?.note) r.note = spec.note;
    if (spec?.officialUrl) r.officialUrl = spec.officialUrl;
  }
  return {
    results,
    ok: results.every((r) => (r.conditional ? true : r.found && r.executable)),
  };
}

/** Human-readable summary for the startup log. */
export function formatReport(report: DependencyReport): string {
  const lines = report.results.map((r) => {
    const tag = r.conditional ? ' (optional, per repo type)' : ' (required)';
    if (r.found && r.executable) {
      return `  [ok]   ${r.command}${tag}: ${r.version ?? 'version unknown'}`;
    }
    if (!r.found) {
      return `  [MISSING] ${r.command}${tag}: not found on PATH`;
    }
    return `  [BROKEN] ${r.command}${tag}: ${r.error}`;
  });
  const notes = Object.entries(DEPENDENCY_SPECS)
    .filter(([, spec]) => spec.note)
    .map(([cmd, spec]) => `  note: ${cmd} — ${spec.note}`);
  return ['Dependency check:', ...lines, ...notes].join('\n');
}
