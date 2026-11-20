import { describe, expect, it } from 'vitest';
import { DEFAULT_OPEN_DENY, isProgramFileType, resolveEditor } from './fileOpen';

/*
 * Commit File Menu and Editor, P1 S5 + section 8. Pure unit tests, no disk and no process (the `exists` check is injected).
 * Contract the builder must provide in server/src/git/fileOpen.ts:
 *   export const DEFAULT_OPEN_DENY: readonly string[]                       the fixed list of section 8 (lowercase, each with its leading dot)
 *   export function isProgramFileType(name: string, pathext?: string): boolean
 *       name = a repo-relative path or a bare file name; only the LAST path segment counts ('/' separated).
 *       extension = text from the last '.' of that segment after trailing dots and spaces are stripped, lowercased.
 *       true when the extension is in DEFAULT_OPEN_DENY or in `pathext` (a %PATHEXT% string: ';' separated, compared lowercased, empty entries ignored).
 *       no extension -> false.
 *   export function resolveEditor(value: string, env: NodeJS.ProcessEnv, exists: (absPath: string) => boolean):
 *       { ok: true; file: string } | { ok: false; error: string }
 *       value '' (or only spaces) or 'code' -> VS Code Code.exe from the first existing of
 *         %LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe, %ProgramFiles%\Microsoft VS Code\Code.exe
 *       otherwise value must be an absolute Windows path to an .exe that `exists`; .cmd/.bat (and anything not .exe) is refused.
 *       error for a missing configured editor contains 'The configured external editor was not found' (GitKraken ErrorMessage-ExternalEditorNotFound).
 * UNVERIFIED: the VS Code install folders are my knowledge of VS Code's installers, not read from this repo; the list in section 8 ends ".cer .crt." where the last dot is read as the end of the sentence.
 */

// Section 8 list, verbatim from "Commit File Menu and Editor.md" (".crt." read as ".crt").
const SPEC_DENY =
  '.exe .com .bat .cmd .ps1 .psm1 .psd1 .ps1xml .psc1 .vb .vbs .vbe .js .jse .ws .wsf .wsh .wsc .msi .msp .mst .lnk .url .website .hta .scr .cpl .jar .reg .pif .application .appref-ms .gadget .msc .scf .inf .xll .appx .appxbundle .msix .msixbundle .diagcab .rdp .settingcontent-ms .library-ms .search-ms .searchconnector-ms .docm .dotm .xlsm .xltm .xlam .pptm .potm .ppam .sldm .chm .hlp .iqy .slk .sct .shs .mde .mda .ade .adp .accde .py .pyw .sh .cer .crt'.split(
    ' ',
  );
const PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

describe('DEFAULT_OPEN_DENY', () => {
  it('holds every extension of section 8, lowercase with its dot', () => {
    expect(SPEC_DENY.length).toBe(72); // guards my own copy of the list
    for (const ext of SPEC_DENY) expect(DEFAULT_OPEN_DENY, ext).toContain(ext);
    for (const ext of DEFAULT_OPEN_DENY) expect(ext).toBe(ext.toLowerCase());
  });
});

describe('isProgramFileType: the fixed deny list', () => {
  it.each(SPEC_DENY)('refuses %s (no PATHEXT needed)', (ext) => {
    expect(isProgramFileType(`file${ext}`, '')).toBe(true);
    expect(isProgramFileType(`some/dir/file${ext}`, '')).toBe(true);
    expect(isProgramFileType(`file${ext}`)).toBe(true); // pathext omitted
  });

  it.each(['.mshxml', '.jnlp', '.themepack', '.iso', '.vhdx', '.mhtml'])('refuses the later deny addition %s (also upper case and with a trailing dot)', (ext) => {
    expect(isProgramFileType(`file${ext}`, '')).toBe(true);
    expect(isProgramFileType(`dir/file${ext.toUpperCase()}`, '')).toBe(true);
    expect(isProgramFileType(`file${ext}.`, '')).toBe(true);
    expect(DEFAULT_OPEN_DENY).toContain(ext);
  });

  it('case does not matter', () => {
    for (const n of ['RUN.EXE', 'Run.Exe', 'x.PS1', 'x.Bat', 'a/b/SETUP.MSI', 'x.Appref-MS', 'x.SETTINGCONTENT-MS', 'macro.DOCM']) expect(isProgramFileType(n, ''), n).toBe(true);
  });

  it('trailing dots and spaces are stripped first (Windows ignores them)', () => {
    for (const n of ['run.exe.', 'run.exe..', 'run.exe ', 'run.exe  ', 'run.exe. ', 'run.exe . ', 'run.exe .', 'x.PS1.', 'dir/x.cmd. .', 'x.lnk ']) expect(isProgramFileType(n, ''), JSON.stringify(n)).toBe(true);
    // stripping must not invent a program type
    for (const n of ['notes.txt.', 'notes.txt ', 'notes.txt. .']) expect(isProgramFileType(n, ''), JSON.stringify(n)).toBe(false);
  });

  it('only the last extension counts', () => {
    for (const n of ['run.exe.txt', 'report.exe.bak', 'a.cmd.pdf', 'archive.js.map']) expect(isProgramFileType(n, ''), n).toBe(false);
    for (const n of ['readme.txt.exe', 'a.pdf.cmd', 'x.tar.sh']) expect(isProgramFileType(n, ''), n).toBe(true);
  });

  it('only the last path segment counts (a program-looking folder name does not matter)', () => {
    expect(isProgramFileType('tools.exe/README', '')).toBe(false);
    expect(isProgramFileType('build.cmd/notes.txt', '')).toBe(false);
    expect(isProgramFileType('a.b/c.d/readme', '')).toBe(false);
    expect(isProgramFileType('tools.d/run.exe', '')).toBe(true);
  });

  it('whole extensions are compared, not prefixes or suffixes', () => {
    for (const n of ['a.json', 'a.jsx', 'a.pyc', 'a.shx', 'a.ps1x', 'a.exe2', 'a.cmdx', 'a.xexe', 'a.mjs', 'a.ts', 'a.shell', 'a.comx', 'a.hlpx', 'a.regx']) expect(isProgramFileType(n, ''), n).toBe(false);
  });
});

describe('isProgramFileType: allowed files', () => {
  it('files with no extension are allowed (Windows asks which app)', () => {
    for (const n of ['README', 'Makefile', 'LICENSE', 'dir.exe/README', 'a/b/Dockerfile', 'noext.', 'noext ']) expect(isProgramFileType(n, ''), JSON.stringify(n)).toBe(false);
  });

  it('everyday document, image and source types are allowed', () => {
    for (const n of ['a.txt', 'a.md', 'a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.png', 'a.jpg', 'a.svg', 'a.zip', 'a.csv', 'a.json', 'a.html', 'a.css', 'a.ts', 'a.tsx', 'a.cs', 'a.java', '.gitignore', '.env']) {
      expect(isProgramFileType(n, ''), n).toBe(false);
    }
  });
});

describe('isProgramFileType: %PATHEXT%', () => {
  it('an extension that is only in PATHEXT is refused (case-insensitive)', () => {
    expect(isProgramFileType('x.foo', '')).toBe(false); // control: not in the fixed list
    expect(isProgramFileType('x.foo', '.COM;.FOO')).toBe(true);
    expect(isProgramFileType('x.FOO', '.com;.foo')).toBe(true);
    expect(isProgramFileType('x.foo.', '.COM;.FOO')).toBe(true);
    expect(isProgramFileType('x.bar', '.COM;.FOO')).toBe(false);
  });

  it('the usual Windows PATHEXT does not make ordinary files refused', () => {
    for (const n of ['a.txt', 'a.pdf', 'a.docx', 'README', 'a.json']) expect(isProgramFileType(n, PATHEXT), n).toBe(false);
    expect(isProgramFileType('a.wsh', PATHEXT)).toBe(true);
  });

  it('empty and odd PATHEXT entries are ignored: they never refuse an extension-less file', () => {
    for (const pe of ['', ';', ';;', ' ; ;', '.COM;;.FOO;', undefined]) {
      expect(isProgramFileType('README', pe), JSON.stringify(pe)).toBe(false);
      expect(isProgramFileType('a.txt', pe), JSON.stringify(pe)).toBe(false);
    }
    expect(isProgramFileType('x.foo', '.COM;;.FOO;')).toBe(true);
  });
});

describe.skipIf(process.platform !== 'win32')('resolveEditor', () => {
  const env: NodeJS.ProcessEnv = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const USER_CODE = 'C:\\Users\\tester\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
  const SYSTEM_CODE = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
  const existsOnly = (...paths: string[]) => {
    const seen: string[] = [];
    const fn = (p: string): boolean => {
      seen.push(p);
      return paths.some((x) => x.toLowerCase() === p.toLowerCase());
    };
    return { fn, seen };
  };

  it('empty value and "code" both mean VS Code from the standard install folders (user install first)', () => {
    for (const value of ['', '   ', 'code']) {
      expect(resolveEditor(value, env, existsOnly(USER_CODE).fn), JSON.stringify(value)).toEqual({ ok: true, file: USER_CODE });
      expect(resolveEditor(value, env, existsOnly(SYSTEM_CODE).fn), JSON.stringify(value)).toEqual({ ok: true, file: SYSTEM_CODE });
      expect(resolveEditor(value, env, existsOnly(USER_CODE, SYSTEM_CODE).fn), JSON.stringify(value)).toEqual({ ok: true, file: USER_CODE });
    }
  });

  it('VS Code not installed: not ok, with a message (never a bare "code" to be found through PATH or the cwd)', () => {
    for (const value of ['', 'code']) {
      const r = resolveEditor(value, env, () => false);
      expect(r.ok, value).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('only absolute paths are ever checked for existence', () => {
    const probe = existsOnly(USER_CODE);
    resolveEditor('', env, probe.fn);
    resolveEditor('C:\\Tools\\edit.exe', env, probe.fn);
    expect(probe.seen.length).toBeGreaterThan(0);
    for (const p of probe.seen) expect(/^[a-zA-Z]:\\/.test(p), p).toBe(true);
  });

  it('an absolute .exe that exists is used as is (extension case does not matter)', () => {
    const exe = 'C:\\Tools\\My Editor\\edit.exe';
    expect(resolveEditor(exe, env, existsOnly(exe).fn)).toEqual({ ok: true, file: exe });
    const upper = 'C:\\Tools\\EDIT.EXE';
    expect(resolveEditor(upper, env, existsOnly(upper).fn)).toEqual({ ok: true, file: upper });
  });

  it('an absolute .exe that does not exist: not ok, "The configured external editor was not found"', () => {
    const r = resolveEditor('C:\\Tools\\missing.exe', env, () => false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('The configured external editor was not found');
  });

  it('.cmd and .bat are refused even when they exist (they would need a shell)', () => {
    for (const p of ['C:\\Tools\\edit.cmd', 'C:\\Tools\\edit.bat', 'C:\\Tools\\EDIT.CMD', 'C:\\Tools\\edit.cmd.', 'C:\\Tools\\edit.cmd ', 'C:\\Tools\\edit.bat. .', 'C:\\Tools\\edit.exe.cmd']) {
      const r = resolveEditor(p, env, () => true);
      expect(r.ok, p).toBe(false);
    }
  });

  it('anything that is not an .exe is refused even when it exists', () => {
    for (const p of ['C:\\Tools\\edit.com', 'C:\\Tools\\edit.ps1', 'C:\\Tools\\edit.lnk', 'C:\\Tools\\edit', 'C:\\Tools\\edit.exe.txt', 'C:\\Tools\\edit.js']) {
      expect(resolveEditor(p, env, () => true).ok, p).toBe(false);
    }
  });

  it('relative paths and bare names are refused (only "code" and absolute paths are accepted)', () => {
    for (const p of ['notepad', 'notepad.exe', 'tools\\edit.exe', '.\\edit.exe', '..\\edit.exe', 'edit.exe', '\\edit.exe', 'C:edit.exe', 'subl']) {
      const r = resolveEditor(p, env, () => true);
      expect(r.ok, p).toBe(false);
    }
  });
});
