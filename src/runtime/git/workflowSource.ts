import { SchemaError, hashWorkflow, type Locale, type ObjectRegistry, type WorkflowDefinition } from '../../core/index.js';
import { DEFAULT_LOCALE } from '../../core/i18n/index.js';
import { validateWorkflow } from '../../core/object/validate/workflow.js';
import type { Vc } from '../../core/object/validate/primitives.js';
import type { AutoCommitOptions } from './autoCommit.js';
import { readSource, sourceVersion } from './sourceFile.js';
import { runSourceTransaction } from './sourceTransaction.js';

/**
 * Workflow source store: read/write `objects/<name>/workflow.json`. PUT runs the
 * same node-chain validation as the loader and commits via the shared source
 * transaction (atomic replace + `git commit --only`), with an optional
 * optimistic `expectVersion` (the current file's content hash). Structural
 * changes take effect on the next `weave dev`/`migrate`; running instances keep
 * their pinned revision.
 */

export interface WorkflowSourceDocument {
  source: string;
  version: string;
  /** semantic hash of the definition (null when the source is invalid JSON) */
  hash?: string;
}

export interface WriteWorkflowSourceOptions {
  projectDir: string;
  registry: ObjectRegistry;
  name: string;
  source: string;
  expectVersion?: string;
  force?: boolean;
  identity?: AutoCommitOptions['identity'];
  locale?: Locale;
}

export interface WriteWorkflowSourceResult extends WorkflowSourceDocument {
  committed: boolean;
}

export function workflowPathOf(name: string): string {
  return `objects/${name}/workflow.json`;
}

export async function readWorkflowSource(
  projectDir: string,
  name: string,
): Promise<WorkflowSourceDocument | null> {
  return readSource(projectDir, workflowPathOf(name));
}

/** validate a `workflow.json` candidate against the registered object */
export function validateWorkflowCandidate(options: {
  registry: ObjectRegistry;
  name: string;
  source: string;
  locale?: Locale;
}): WorkflowDefinition {
  const { registry, name, source, locale } = options;
  if (registry.get(name) === undefined) {
    throw new SchemaError('data.objectUnknown', { object: name }, locale);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new SchemaError('parse.json.invalid', {}, locale);
  }
  const vc: Vc = { object: name, locale: locale ?? DEFAULT_LOCALE };
  const workflow = validateWorkflow(raw, vc);
  if (workflow === undefined) {
    throw new SchemaError('workflow.definition.missing', { object: name }, locale);
  }
  return workflow;
}

export async function writeWorkflowSource(
  options: WriteWorkflowSourceOptions,
): Promise<WriteWorkflowSourceResult> {
  const { projectDir, registry, name, source, expectVersion, force, identity, locale } = options;
  const workflow = validateWorkflowCandidate({ registry, name, source, locale });
  const result = await runSourceTransaction({
    projectDir,
    files: [{ path: workflowPathOf(name), source, expectVersion }],
    force,
    identity,
    locale,
    message: `chore(workflow): update ${name}`,
  });
  return { source, version: sourceVersion(source), hash: hashWorkflow(workflow), committed: result.committed };
}
