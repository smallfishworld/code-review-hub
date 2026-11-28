import { spawn } from 'node:child_process';
import { checkDependencies, DEPENDENCY_SPECS, type DependencyReport } from './detector.js';
import { locateCommand } from './which.js';

/**
 * Official-channel dependency repair for `ocr`, `svn`, and `git`.
 *
 * Strictly allowlisted to the three known dependencies and hardcoded official
 * package identifiers — user input never enters a command line.
 */

export const OFFICIAL_DOWNLOAD_URLS: Record<string, string> = {
  ocr: 'https://www.npmjs.com/package/@smallfishworld/open-code-review-svn',
  svn: 'https://subversion.apache.org/packages.html',
  git: 'https://git-scm.com/downloads',
};

export interface RepairPlan {
  command: string;
  binary: string;
  args: string[];
  displayCommand: string;
  officialUrl: string;
}

export interface RepairResult {
  ok: boolean;
  command: string;
  method?: string;
  officialUrl: string;
  manualCommand: string;
  output: string;
  error?: string;
  report: DependencyReport;
}

export class RepairError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

const inFlight = new Set<string>();
const WINDOWS = process.platform === 'win32';

const OCR_NPM_SPEC = '@smallfishworld/open-code-review-svn@svn';

export function manualInstallHint(command: string, platform = process.platform): string {
  if (command === 'ocr') {
    return `npm install -g ${OCR_NPM_SPEC}`;
  }
  if (command === 'svn') {
    if (platform === 'darwin') return 'brew install subversion';
    if (platform === 'win32') return 'winget install --id Apache.Subversion';
    return 'sudo apt-get install -y subversion  # 或 sudo dnf install -y subversion';
  }
  if (command === 'git') {
    if (platform === 'darwin') return 'brew install git';
    if (platform === 'win32') return 'winget install --id Git.Git';
    return 'sudo apt-get install -y git  # 或 sudo dnf install -y git';
  }
  return '';
}

export async function resolveRepairPlan(
  command: string,
  platform = process.platform,
  locator: typeof locateCommand = locateCommand,
  isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false
): Promise<RepairPlan | null> {
  const officialUrl = OFFICIAL_DOWNLOAD_URLS[command] ?? '';
  if (command === 'ocr') {
    const npm = await locator('npm');
    if (!npm.path) return null;
    const args = ['install', '-g', OCR_NPM_SPEC];
    return {
      command,
      binary: npm.path,
      args,
      displayCommand: `npm ${args.join(' ')}`,
      officialUrl,
    };
  }

  if (command === 'svn' || command === 'git') {
    if (platform === 'darwin') {
      const brew = await locator('brew');
      if (!brew.path) return null;
      const pkg = command === 'svn' ? 'subversion' : 'git';
      return {
        command,
        binary: brew.path,
        args: ['install', pkg],
        displayCommand: `brew install ${pkg}`,
        officialUrl,
      };
    }
    if (platform === 'win32') {
      const winget = await locator('winget');
      if (!winget.path) return null;
      const id = command === 'svn' ? 'Apache.Subversion' : 'Git.Git';
      const args = [
        'install',
        '--id',
        id,
        '--accept-source-agreements',
        '--accept-package-agreements',
      ];
      return {
        command,
        binary: winget.path,
        args,
        displayCommand: `winget install --id ${id}`,
        officialUrl,
      };
    }
    if (platform === 'linux' && isRoot) {
      const pkg = command === 'svn' ? 'subversion' : 'git';
      for (const mgr of ['apt-get', 'dnf', 'yum'] as const) {
        const found = await locator(mgr);
        if (found.path) {
          return {
            command,
            binary: found.path,
            args: ['install', '-y', pkg],
            displayCommand: `${mgr} install -y ${pkg}`,
            officialUrl,
          };
        }
      }
    }
  }
  return null;
}

function runCommandWithOutput(
  binary: string,
  args: string[],
  timeoutMs = 300_000
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const needsShell = WINDOWS && /\.(cmd|bat)$/i.test(binary);
    const child = spawn(binary, args, {
      windowsHide: true,
      shell: needsShell,
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-12_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${err.message}`.trim(), timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim(), timedOut });
    });
  });
}

export async function repairDependency(
  command: string,
  options: { onLog?: (msg: string) => void } = {}
): Promise<RepairResult> {
  if (!Object.prototype.hasOwnProperty.call(DEPENDENCY_SPECS, command)) {
    throw new RepairError(`不支持修复未知依赖：${command}`, 400);
  }
  if (inFlight.has(command)) {
    throw new RepairError(`依赖「${command}」正在修复中，请稍候`, 409);
  }

  const officialUrl = OFFICIAL_DOWNLOAD_URLS[command] ?? '';
  const manualCommand = manualInstallHint(command);

  inFlight.add(command);
  try {
    const plan = await resolveRepairPlan(command);
    if (!plan) {
      const report = await checkDependencies();
      return {
        ok: false,
        command,
        officialUrl,
        manualCommand,
        output: '',
        error: `当前运行环境缺少可直接调用的官方包管理器（或需要管理员/root 权限），请在服务器上手动执行安装命令或访问官方页面下载。`,
        report,
      };
    }

    options.onLog?.(`开始修复依赖 ${command}：${plan.displayCommand}`);
    const run = await runCommandWithOutput(plan.binary, plan.args);
    const report = await checkDependencies();
    const dep = report.results.find((r) => r.command === command);
    const repaired = Boolean(dep && dep.found && dep.executable);

    if (run.timedOut) {
      return {
        ok: false,
        command,
        method: plan.displayCommand,
        officialUrl,
        manualCommand,
        output: run.output,
        error: '官方渠道下载安装超时（5 分钟），请检查网络后重试或手动安装。',
        report,
      };
    }

    if (run.code !== 0 || !repaired) {
      const versionHint =
        command === 'ocr' && dep?.error?.includes('版本过低')
          ? `（npm 镜像缓存或 dist-tag 可能仍指向旧版，请确认使用 ${OCR_NPM_SPEC} 或指定 >= ${dep.minVersion ?? '1.12.13'} 的具体版本）`
          : '';
      return {
        ok: false,
        command,
        method: plan.displayCommand,
        officialUrl,
        manualCommand,
        output: run.output,
        error:
          run.code !== 0
            ? `安装命令退出码 ${run.code}，请查看下方输出日志或按官方指引手动安装。`
            : `安装命令已执行完成，但重新检测仍未通过（${dep?.error ?? '可能需重启服务以刷新 PATH'}）${versionHint}。`,
        report,
      };
    }

    options.onLog?.(`依赖 ${command} 修复成功：${dep?.version ?? ''}`);
    return {
      ok: true,
      command,
      method: plan.displayCommand,
      officialUrl,
      manualCommand,
      output: run.output,
      report,
    };
  } finally {
    inFlight.delete(command);
  }
}
