import { OPT_IN_FIELD_TYPES, PRIMITIVE_FIELD_TYPES } from '../../core/types/registry.js';
import { PROJECT_TYPES, type ProjectType } from '../types/values.js';

/**
 * Project-type presets — the single source of truth for what each `--type`
 * starting preset carries (narrative, default `features.fieldTypes` whitelist,
 * subsystem composition, and business-only extras). `PROJECT_TYPES` stays a
 * closed 4-value set; adding a built-in type means extending this record (the
 * `Record<ProjectType, …>` type forces every preset to be declared).
 */
export interface ProjectTypeDefinition {
  /** human narrative shown in the scaffolded README / config comment */
  narrative: string;
  /** enable the script subsystem sandbox at scaffold time */
  script: boolean;
  /** default `features.fieldTypes` whitelist (fail-closed gating) */
  fieldTypes: string[];
  /** business-only extras: `pages/` layouts + generated `*.client.js` (retired 2026-10, always false) */
  businessUI: boolean;
}

const PRIMITIVES: readonly string[] = PRIMITIVE_FIELD_TYPES;
const OPT_IN: readonly string[] = OPT_IN_FIELD_TYPES;

export const PROJECT_TYPE_DEFINITIONS: Record<ProjectType, ProjectTypeDefinition> = {
  agent: {
    narrative: 'AI-Agent backend: metadata-driven objects with REST access for AI agents',
    script: false,
    fieldTypes: [...PRIMITIVES],
    businessUI: false,
  },
  governance: {
    narrative: 'Governance platform: auditable, permission-scoped business objects',
    script: false,
    fieldTypes: [...PRIMITIVES, ...OPT_IN],
    businessUI: false,
  },
  service: {
    narrative: 'Business service: headless backend with RBAC and a REST API',
    script: true,
    fieldTypes: [...PRIMITIVES, ...OPT_IN],
    businessUI: false,
  },
  business: {
    narrative: 'Business backend: objects and formulas on Postgres',
    script: true,
    fieldTypes: [...PRIMITIVES, ...OPT_IN],
    businessUI: false,
  },
};

/** the preset definition for a project type (undefined when unset/unknown) */
export function projectTypeDef(type: ProjectType | undefined): ProjectTypeDefinition | undefined {
  return type === undefined ? undefined : PROJECT_TYPE_DEFINITIONS[type];
}

/** whether a project type carries business-only UI artifacts (`pages/`, `*.client.js`). Retired 2026-10: always false (no in-project renderer; `businessUI` groundwork removed). */
export function isBusinessUI(type: ProjectType | undefined): boolean {
  return projectTypeDef(type)?.businessUI === true;
}

export { PROJECT_TYPES };
