/**
 * Output of a command.
 *
 * The command functions take an {@link CommandIO}, so a test can capture what
 * a command prints without spawning a process.
 */

/** Receives the output of one command. */
export interface CommandIO {
  /** Write to standard output. */
  stdout: (text: string) => void;
  /** Write to standard error. */
  stderr: (text: string) => void;
}

/** The process streams, used when no other sink is supplied. */
export const processIO: CommandIO = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Write one line to standard output. */
export function out(io: CommandIO, line = ""): void {
  io.stdout(`${line}\n`);
}

/** Write one line to standard error. */
export function err(io: CommandIO, line: string): void {
  io.stderr(`${line}\n`);
}

/** A memory sink, handy in tests and for embedding the CLI. */
export function createMemoryIO(): CommandIO & { stdoutText: string; stderrText: string } {
  let stdoutText = "";
  let stderrText = "";
  return {
    stdout: (text) => {
      stdoutText += text;
    },
    stderr: (text) => {
      stderrText += text;
    },
    get stdoutText() {
      return stdoutText;
    },
    get stderrText() {
      return stderrText;
    },
  };
}
