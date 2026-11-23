import { vi } from 'vitest';

/** Run a script's main() in process, capturing what it writes to stdout and stderr. */
export function runMain(main: (args: readonly string[]) => number, args: string[]): { status: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => ((stdout += String(chunk)), true));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => ((stderr += String(chunk)), true));
  try {
    return { status: main(args), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}
