import { spawn } from 'node:child_process';
import { isIP } from 'node:net';

export function browserUrl(host: string, port: number): string {
  const address = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const authority = isIP(address) === 6 ? `[${address}]` : address;
  return new URL(`http://${authority}:${port}/`).href;
}

export function shouldOpenBrowser(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  interactive: boolean,
  requested: boolean,
): boolean {
  if (env.OPEN_BROWSER === 'false' || env.OPEN_BROWSER === '0') return false;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') return false;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  if (env.OPEN_BROWSER === 'true' || env.OPEN_BROWSER === '1') return true;
  return requested && interactive && !env.CI && !env.SSH_CONNECTION && !env.SSH_TTY;
}

/** Best-effort desktop integration; never block or stop the listening server. */
export function openBrowser(url: string, onError: (message: string) => void): void {
  const command = process.platform === 'win32' ? 'rundll32.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', (err) => onError(err.message));
    child.once('exit', (code) => {
      if (code !== null && code !== 0) onError(`Browser launcher exited with code ${code}`);
    });
    child.unref();
  } catch (err) {
    onError(String(err));
  }
}
