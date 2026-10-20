/**
 * A very small wrapper around `node:sqlite`.
 *
 * The store only needs four things from the driver: run a statement, read a
 * row, read many rows and run a transaction. This module adds exactly those
 * and nothing else — no ORM, no query builder, no abstraction that would
 * hide what SQL is actually executed.
 *
 * `node:sqlite` is a *synchronous* driver (that is one of the reasons the
 * desktop tier uses it), so everything in here is synchronous. The ports of
 * `@openmatel/core` are asynchronous; the adapters bridge that with `async`
 * functions that do their work synchronously.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * A value SQLite can bind.
 *
 * `node:sqlite` rejects `undefined` and (depending on the version) booleans,
 * so the store always converts them explicitly: `undefined` becomes `null`
 * and a boolean becomes `0`/`1`.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** `true` when the path addresses the in-memory database. */
export const isMemoryPath = (path: string): boolean =>
  path === ":memory:" || path === "" || path.startsWith("file::memory:");

/**
 * Turn the parameters into values SQLite accepts.
 *
 * `node:sqlite` rejects `undefined`; a parameter that is not there is a `NULL`.
 */
const bindable = (params: SqlValue[]): SqlValue[] =>
  params.map((param) => (param === undefined ? null : param));

/** A thin, cached wrapper around one `DatabaseSync` handle. */
export class SqliteDatabase {
  /** The raw driver handle. */
  readonly raw: DatabaseSync;

  /** Prepared statements, keyed by SQL text. */
  private readonly statements = new Map<string, StatementSync>();

  /** `true` once {@link close} ran. */
  private closed = false;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
  }

  /** `true` when the handle was closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Execute one or more statements without parameters. */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Prepare a statement, reusing the cached one when possible. */
  prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.raw.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  /** Run a statement that does not return rows. */
  run(sql: string, ...params: SqlValue[]): void {
    this.prepare(sql).run(...bindable(params));
  }

  /** Run a statement and return the first row, if there is one. */
  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...bindable(params)) as T | undefined;
  }

  /** Run a statement and return every row. */
  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...bindable(params)) as T[];
  }

  /**
   * Run `body` inside a transaction.
   *
   * `BEGIN IMMEDIATE` takes the write lock right away, so two writers cannot
   * read the same state and then both try to upgrade to a write lock (the
   * classic "database is locked" deadlock of SQLite). The transaction is
   * rolled back when `body` throws.
   */
  transaction<T>(body: () => T): T {
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.exec("ROLLBACK");
      } catch {
        // The transaction was already gone; the original error is the useful one.
      }
      throw error;
    }
  }

  /** Close the handle. Closing twice is a no-op. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.raw.close();
  }
}
