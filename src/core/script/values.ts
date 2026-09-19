/** Object-level script source files editable through the admin API. */
export const SCRIPT_SOURCE_KINDS = {
  SERVER: 'server',
  SHOW_CLIENT: 'show.client',
  LIST_CLIENT: 'list.client',
} as const;

export type ScriptSourceKind = typeof SCRIPT_SOURCE_KINDS[keyof typeof SCRIPT_SOURCE_KINDS];