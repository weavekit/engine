import type { AuditMode } from '../../core/audit/types.js';
import { OPT_IN_FIELD_TYPES, PRIMITIVE_FIELD_TYPES } from '../../core/types/registry.js';
import { PROJECT_TYPES, type ProjectType } from '../types/values.js';

/**
 * Project-type presets — the single source of truth for what each `--type`
 * starting preset carries (narrative, default `features.fieldTypes` whitelist,
 * subsystem composition). `PROJECT_TYPES` stays a closed 3-value set; adding a
 * built-in type means extending this record (the `Record<ProjectType, …>` type
 * forces every preset to be declared).
 */
export interface ProjectTypeDefinition {
  /** human narrative shown in the scaffolded README / config comment */
  narrative: string;
  /** enable the script subsystem sandbox at scaffold time */
  script: boolean;
  /**
   * audit mode enabled at scaffold time (`false` = audit off, not preconfigured).
   * `transactional` writes the audit row inside the business transaction
   * (crash-safe) — the governance preset relies on it.
   */
  audit: AuditMode | false;
  /** default `features.fieldTypes` whitelist (fail-closed gating) */
  fieldTypes: string[];
}

const PRIMITIVES: readonly string[] = PRIMITIVE_FIELD_TYPES;
const OPT_IN: readonly string[] = OPT_IN_FIELD_TYPES;

export const PROJECT_TYPE_DEFINITIONS: Record<ProjectType, ProjectTypeDefinition> = {
  agent: {
    narrative: 'AI-Agent backend: metadata-driven objects with REST access for AI agents',
    script: false,
    audit: false,
    fieldTypes: [...PRIMITIVES],
  },
  governance: {
    narrative: 'Governance platform: auditable, permission-scoped business objects',
    script: false,
    audit: 'transactional',
    fieldTypes: [...PRIMITIVES, ...OPT_IN],
  },
  service: {
    narrative: 'Business service: headless backend with RBAC and a REST API',
    script: true,
    audit: false,
    fieldTypes: [...PRIMITIVES, ...OPT_IN],
  },
};

/** the preset definition for a project type (undefined when unset/unknown) */
export function projectTypeDef(type: ProjectType | undefined): ProjectTypeDefinition | undefined {
  return type === undefined ? undefined : PROJECT_TYPE_DEFINITIONS[type];
}

export { PROJECT_TYPES };
