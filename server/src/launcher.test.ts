import { describe, expect, it } from 'vitest';
import { browserCandidates, pickBrowser, windowArgs } from './launcher';

const ENV = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } as NodeJS.ProcessEnv;

describe('browser picker', () => {
  it('order: Edge x86, Edge x64, Chrome Program Files, Chrome x86, Chrome LOCALAPPDATA', () => {
    expect(browserCandidates(ENV, 'win32')).toEqual([
      'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\PF\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\PF86\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });
  it('takes the first one that exists; Edge beats Chrome; none gives null', () => {
    const all = browserCandidates(ENV, 'win32');
    expect(pickBrowser(() => true, ENV, 'win32')).toBe(all[0]);
    expect(pickBrowser((p) => p === all[1] || p === all[2], ENV, 'win32')).toBe(all[1]);
    expect(pickBrowser((p) => p === all[4], ENV, 'win32')).toBe(all[4]);
    expect(pickBrowser(() => false, ENV, 'win32')).toBeNull();
  });
  it('no candidates off Windows', () => {
    expect(pickBrowser(() => true, ENV, 'linux')).toBeNull();
  });
  it('window flags', () => {
    expect(windowArgs('http://127.0.0.1:1/?token=t', 'C:\\data')).toEqual([
      '--app=http://127.0.0.1:1/?token=t',
      '--user-data-dir=C:\\data\\browser',
      '--no-first-run',
      '--no-default-browser-check',
    ]);
  });
});
