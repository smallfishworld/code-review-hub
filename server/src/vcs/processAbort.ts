import { execFile, type ChildProcess } from 'node:child_process';

/** A cancellable command on POSIX is spawned in its own process group. */
export function bindProcessAbort(child: ChildProcess, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  let escalation: NodeJS.Timeout | undefined;
  const abort = () => {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    }
    const kill = (name: NodeJS.Signals) => {
      try {
        process.kill(-pid, name);
      } catch {
        // The process group has already exited.
      }
    };
    kill('SIGTERM');
    escalation = setTimeout(() => kill('SIGKILL'), 1500);
    escalation.unref();
  };
  signal.addEventListener('abort', abort, { once: true });
  return () => {
    signal.removeEventListener('abort', abort);
    if (escalation) clearTimeout(escalation);
  };
}
