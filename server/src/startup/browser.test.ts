import { describe, expect, it } from 'vitest';
import { browserUrl, shouldOpenBrowser } from './browser.js';

describe('browser startup', () => {
  it('uses the configured listening port and normalizes wildcard hosts', () => {
    expect(browserUrl('0.0.0.0', 4321)).toBe('http://localhost:4321/');
    expect(browserUrl('::', 3000)).toBe('http://localhost:3000/');
    expect(browserUrl('127.0.0.1', 8080)).toBe('http://127.0.0.1:8080/');
    expect(browserUrl('::1', 8080)).toBe('http://[::1]:8080/');
  });
  it('opens on interactive desktops only when requested by default', () => {
    expect(shouldOpenBrowser({}, 'win32', true, true)).toBe(true);
    expect(shouldOpenBrowser({}, 'darwin', true, true)).toBe(true);
    expect(shouldOpenBrowser({ DISPLAY: ':0' }, 'linux', true, true)).toBe(true);
    expect(shouldOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux', true, true)).toBe(true);
    expect(shouldOpenBrowser({}, 'win32', true, false)).toBe(false);
    expect(shouldOpenBrowser({}, 'darwin', false, true)).toBe(false);
  });
  it('skips headless, SSH, CI and explicit opt-outs', () => {
    expect(shouldOpenBrowser({}, 'linux', true, true)).toBe(false);
    expect(shouldOpenBrowser({ CI: 'true' }, 'win32', true, true)).toBe(false);
    expect(shouldOpenBrowser({ SSH_CONNECTION: 'remote' }, 'darwin', true, true)).toBe(false);
    expect(shouldOpenBrowser({ OPEN_BROWSER: 'false' }, 'win32', true, true)).toBe(false);
    expect(shouldOpenBrowser({ OPEN_BROWSER: '0' }, 'darwin', true, true)).toBe(false);
  });
  it('allows explicit opt-in without a terminal but never launches on headless Linux', () => {
    expect(shouldOpenBrowser({ OPEN_BROWSER: 'true' }, 'win32', false, false)).toBe(true);
    expect(shouldOpenBrowser({ OPEN_BROWSER: 'true' }, 'linux', false, false)).toBe(false);
  });
});
