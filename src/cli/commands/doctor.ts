import { createRequire } from 'node:module';
import kleur from 'kleur';
import {
  buildMappingReport,
  buildSystemTables,
  createPool,
  diffAll,
  inspectSchema,
  type ActualTable,
} from '../../core/index.js';
import { loadSchemaDir } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import { DOCTOR_STATUSES, type DoctorCheck, type DoctorOptions, type DoctorReport } from '../types/index.js';

/**
 * `weave doctor` — read-only preflight. Verifies the connection, PostgreSQL
 * compatibility, schema↔DB drift, engine system tables, and (when the script
 * subsystem is enabled) the restricted-SQL role + sandbox backend. Never writes
 * and never takes the migration advisory lock; safe to run before `weave
 * migrate` / `weave deploy apply` (and via `weave migrate --preflight`).
 */

/** tested floor / recommended PostgreSQL server_version_num */
const MIN_PG_VERSION_NUM = 120000;
const RECOMMENDED_PG_VERSION_NUM = 140000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** strip the password from a connection string before printing it */
function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:/@]+):[^@/]+@/, '://$1:***@');
}

/** run the checks (no printing) — reused by `weave doctor` and `migrate --preflight` */
export async function runDoctor(cwd: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck['status'], detail: string): void => {
    checks.push({ name, status, detail });
  };

  let config;
  try {
    config = await loadConfig(cwd);
    add('config', DOCTOR_STATUSES.PASS, 'weavekit.config.ts loaded');
  } catch (error) {
    add('config', DOCTOR_STATUSES.FAIL, message(error));
    return { checks, ok: false };
  }

  const databaseUrl = config.migrationDatabaseUrl ?? config.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    add('database-url', DOCTOR_STATUSES.FAIL, 'DATABASE_URL is not set (config or env)');
    return { checks, ok: false };
  }
  add('database-url', DOCTOR_STATUSES.PASS, redactUrl(databaseUrl));

  const pool = createPool(databaseUrl);
  try {
    try {
      const res = await pool.query("SELECT current_setting('server_version_num')::int AS num, version() AS full");
      const row = res.rows[0] as { num: number; full: string };
      const num = Number(row.num);
      add('connection', DOCTOR_STATUSES.PASS, String(row.full).split(' ').slice(0, 2).join(' '));
      if (num >= MIN_PG_VERSION_NUM) {
        add(
          'postgres-version',
          DOCTOR_STATUSES.PASS,
          `${num}${num < RECOMMENDED_PG_VERSION_NUM ? ` (recommended >= ${RECOMMENDED_PG_VERSION_NUM})` : ''}`,
        );
      } else {
        add('postgres-version', DOCTOR_STATUSES.FAIL, `${num} is below the engine floor ${MIN_PG_VERSION_NUM}`);
      }
    } catch (error) {
      add('connection', DOCTOR_STATUSES.FAIL, message(error));
      return { checks, ok: false };
    }

    let actual: Map<string, ActualTable>;
    try {
      actual = await inspectSchema(pool);
    } catch (error) {
      add('schema-inspect', DOCTOR_STATUSES.FAIL, message(error));
      return { checks, ok: false };
    }

    // schema ↔ DB drift: what `weave migrate` / `weave deploy apply` would apply
    try {
      const schemaDir = config.schemaDir ?? cwd;
      const { registry } = await loadSchemaDir(schemaDir, {
        locale: config.locale,
        allowedFieldTypes: config.features?.fieldTypes,
        fieldTypes: await resolveProjectFieldTypes(cwd, config),
      });
      const report = buildMappingReport(registry.list(), actual, config.locale);
      const drifting = report.tables.filter((table) => !table.exists || table.drift);
      if (drifting.length === 0) {
        add('schema-drift', DOCTOR_STATUSES.PASS, `${report.totals.objects} object(s) in sync`);
      } else {
        add('schema-drift', DOCTOR_STATUSES.WARN, `${drifting.length} object(s) drift — run "weave migrate"`);
      }
    } catch (error) {
      add('schema-drift', DOCTOR_STATUSES.FAIL, message(error));
    }

    // engine-owned system tables present + shaped as the current engine expects
    const systemStatements = diffAll(buildSystemTables(), actual);
    if (systemStatements.length === 0) {
      add('system-tables', DOCTOR_STATUSES.PASS, 'engine system tables provisioned');
    } else {
      add('system-tables', DOCTOR_STATUSES.WARN, `missing/out-of-date (${systemStatements.length} DDL) — run "weave migrate"`);
    }

    // restricted-SQL RLS role + sandbox backend (only when the script subsystem is on)
    if (config.subsystems?.script?.enabled === true) {
      const role = config.subsystems.script.sandbox?.rls?.role ?? 'weavekit_query';
      const res = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present, pg_has_role(current_user, $1, 'MEMBER') AS member",
        [role],
      );
      const row = res.rows[0] as { present: boolean; member: boolean };
      if (row.present && row.member) {
        add('rls-role', DOCTOR_STATUSES.PASS, `role "${role}" present and grantable`);
      } else {
        add(
          'rls-role',
          DOCTOR_STATUSES.FAIL,
          `role "${role}"${row.present ? '' : ' is missing'}${row.member ? '' : ' is not granted to current_user'}`,
        );
      }
      try {
        createRequire(import.meta.url).resolve('isolated-vm');
        add('sandbox', DOCTOR_STATUSES.PASS, 'isolated-vm resolvable');
      } catch {
        add('sandbox', DOCTOR_STATUSES.FAIL, 'isolated-vm is not installed (script subsystem enabled)');
      }
    } else {
      add('rls-role', DOCTOR_STATUSES.SKIP, 'script subsystem disabled');
      add('sandbox', DOCTOR_STATUSES.SKIP, 'script subsystem disabled');
    }
  } finally {
    await pool.end();
  }

  return { checks, ok: !checks.some((check) => check.status === DOCTOR_STATUSES.FAIL) };
}

/** `weave doctor` — run the preflight and print a report; exit 1 on any failure */
export async function doctor(cwd: string, options: DoctorOptions): Promise<void> {
  const p = options.printer;
  const report = await runDoctor(cwd);

  if (p.json) {
    p.data(report);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const rows: string[][] = [['check', 'status', 'detail']];
  for (const check of report.checks) {
    const status =
      check.status === DOCTOR_STATUSES.PASS
        ? kleur.green('pass')
        : check.status === DOCTOR_STATUSES.WARN
          ? kleur.yellow('warn')
          : check.status === DOCTOR_STATUSES.FAIL
            ? kleur.red('fail')
            : kleur.dim('skip');
    rows.push([check.name, status, check.detail]);
  }
  p.table(rows);
  if (report.ok) {
    p.log(kleur.green('doctor: all checks passed'));
  } else {
    p.error('doctor: one or more checks failed');
    process.exitCode = 1;
  }
}
