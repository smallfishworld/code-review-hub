import { describe, it, expect } from 'vitest';
import {
  manualInstallHint,
  repairDependency,
  RepairError,
  resolveRepairPlan,
} from './repair.js';

const mockLocator =
  (available: Record<string, string>) => async (cmd: string) =>
    available[cmd] ? { found: true, path: available[cmd] } : { found: false };

describe('dependency repair plan resolution', () => {
  it('resolves ocr repair via official npm package', async () => {
    const plan = await resolveRepairPlan('ocr', 'darwin', mockLocator({ npm: '/usr/bin/npm' }));
    expect(plan).not.toBeNull();
    expect(plan!.binary).toBe('/usr/bin/npm');
    expect(plan!.args).toEqual(['install', '-g', '@smallfishworld/open-code-review-svn@latest']);
  });

  it('resolves svn/git via brew on macOS and winget on Windows', async () => {
    const macSvn = await resolveRepairPlan('svn', 'darwin', mockLocator({ brew: '/opt/homebrew/bin/brew' }));
    expect(macSvn?.displayCommand).toBe('brew install subversion');

    const winGit = await resolveRepairPlan('git', 'win32', mockLocator({ winget: 'C:\\winget.exe' }));
    expect(winGit?.args).toContain('Git.Git');
  });

  it('returns null on non-root Linux so it never hangs waiting for sudo', async () => {
    const plan = await resolveRepairPlan('svn', 'linux', mockLocator({ 'apt-get': '/usr/bin/apt-get' }), false);
    expect(plan).toBeNull();

    const rootPlan = await resolveRepairPlan('svn', 'linux', mockLocator({ 'apt-get': '/usr/bin/apt-get' }), true);
    expect(rootPlan?.displayCommand).toBe('apt-get install -y subversion');
  });

  it('rejects unknown dependency commands (strict allowlist)', async () => {
    await expect(repairDependency('rm -rf /')).rejects.toThrowError(RepairError);
    expect(manualInstallHint('ocr')).toContain('@smallfishworld/open-code-review-svn');
  });
});
