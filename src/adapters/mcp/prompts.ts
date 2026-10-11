import type { Locale, PromptDescriptor, PromptResult, PromptsProvider } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import { builtinPromptDescriptors, isBuiltinPromptName, renderBuiltinPrompt } from '../../core/index.js';
import type { McpSession } from './session.js';
import type { McpEngine } from './types.js';

/**
 * MCP prompts surface: the engine's built-in, schema-derived prompts plus an
 * optional host provider (business templates). Built-ins are RBAC-filtered per
 * identity and re-checked on render (list + get, like the tool surface); the
 * provider's content is opaque to the engine. Built-in names are reserved —
 * a provider entry with one of those names is ignored.
 */

/** prompt config (from `adapters.mcp.prompts`) */
export interface McpPromptsConfig {
  /** expose the built-in schema-derived prompts (default true) */
  builtins?: boolean;
  /** host-supplied business prompts (opaque); absent = none */
  provider?: PromptsProvider;
}

/** resolve the built-in + provider prompt descriptors visible to the session identity */
export async function listPrompts(
  engine: McpEngine,
  session: McpSession,
  config?: McpPromptsConfig,
): Promise<PromptDescriptor[]> {
  const prompts: PromptDescriptor[] =
    config?.builtins === false ? [] : builtinPromptDescriptors(engine.registry, session.user.roles);

  if (config?.provider !== undefined) {
    const provided = await config.provider.list({ subjectId: session.user.id, roles: session.user.roles });
    for (const entry of provided) {
      // reserved built-in names win; drop duplicates to keep the list unique
      if (isBuiltinPromptName(entry.name) || prompts.some((p) => p.name === entry.name)) continue;
      prompts.push(entry);
    }
  }
  return prompts;
}

/**
 * Expand one prompt. Built-ins render from the schema (RBAC-checked); otherwise
 * the provider is asked. An unknown name throws `prompt.notFound`.
 */
export async function getPrompt(
  engine: McpEngine,
  session: McpSession,
  name: string,
  args: Record<string, string>,
  locale: Locale,
  config?: McpPromptsConfig,
): Promise<PromptResult> {
  if (config?.builtins !== false && isBuiltinPromptName(name)) {
    return renderBuiltinPrompt(engine.registry, name, args, session.user.roles, locale);
  }

  if (config?.provider !== undefined) {
    const result = await config.provider.get(name, args, { subjectId: session.user.id, roles: session.user.roles });
    if (result !== null) return result;
  }

  throw new SchemaError('prompt.notFound', { name }, locale);
}
