import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './client.js'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/** Migration filenames sort lexicographically, so zero-pad the prefix: 001, 002, ... */
export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * Applies pending migrations in order. Safe to call on every boot: each file is
 * recorded by name once applied, and already-applied files are skipped.
 *
 * Each migration runs inside its own transaction, so a failure half way through
 * a file leaves the schema untouched rather than partially migrated.
 */
export async function migrate(db: Database): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `)

  const applied = await db.query<{ name: string }>('SELECT name FROM schema_migrations')
  const done = new Set(applied.rows.map((r) => r.name))

  const ran: string[] = []
  for (const name of migrationFiles()) {
    if (done.has(name)) continue

    const sql = readFileSync(join(migrationsDir, name), 'utf8')
    await db.exec(`BEGIN;\n${sql}\n;COMMIT;`)
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
    ran.push(name)
  }

  return ran
}
