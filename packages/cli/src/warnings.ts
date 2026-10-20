/**
 * Warning hygiene for the CLI.
 *
 * On some Node.js versions importing `node:sqlite` emits an
 * `ExperimentalWarning`. The CLI is a normal desktop tool, so it should not
 * greet every user with a warning about a built-in module the tool is designed
 * around — but every *other* warning must still be printed by Node.
 *
 * The filter wraps `process.emitWarning`: the SQLite experimental warning is
 * dropped, every other warning is handed back to the original emitter (the
 * "re-emit" approach). We deliberately do not touch `process.noDeprecation`
 * and do not remove the warning listeners of the process.
 */

let installed = false;

/** `true` for exactly the warning this module suppresses. */
function isSqliteExperimentalWarning(warning: string | Error, args: unknown[]): boolean {
  const first = args[0];
  const optionType =
    typeof first === "object" && first !== null && "type" in first
      ? String((first as { type?: unknown }).type)
      : undefined;
  const name =
    typeof first === "string" ? first : (optionType ?? (typeof warning === "string" ? undefined : warning.name));
  const message = typeof warning === "string" ? warning : warning.message;
  return name === "ExperimentalWarning" && /sqlite/i.test(message);
}

/**
 * Install the filter once.
 *
 * Call this before the SQLite store is imported. The bundled CLI routes
 * `node:sqlite` through a lazy shim for exactly that reason.
 */
export function suppressSqliteExperimentalWarning(): void {
  if (installed) return;
  installed = true;

  const original = process.emitWarning;
  process.emitWarning = function filteredEmitWarning(
    warning: string | Error,
    ...args: unknown[]
  ): void {
    if (isSqliteExperimentalWarning(warning, args)) return;
    (original as unknown as (...params: unknown[]) => void).apply(process, [warning, ...args]);
  } as typeof process.emitWarning;
}
