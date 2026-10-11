/**
 * MCP prompts seam.
 *
 * MCP exposes three primitives: **tools** (the model calls), **resources** (the
 * app/user attaches context) and **prompts** (the *user* triggers a template
 * that expands into a set of messages). Prompts are inherently user-facing and
 * often business-flavored, so the engine does not author them: it ships a small
 * set of **schema-derived** built-in prompts (see `core/prompts`) and lets a host
 * inject its own via this provider seam.
 *
 * The engine treats provider content as opaque (it only keeps the shape) — a
 * console/enterprise/plugin supplies the business templates. With no provider
 * configured only the built-in prompts are exposed.
 */

/** one argument a prompt accepts (MCP arguments are always strings) */
export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** the roles a prompt message may carry (mirrors the MCP protocol) */
export type PromptRole = 'user' | 'assistant';

/** one message a prompt expands to */
export interface PromptMessage {
  role: PromptRole;
  content: { type: 'text'; text: string };
}

/** a prompt as advertised by `prompts/list` */
export interface PromptDescriptor {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
}

/** the expansion of a prompt, returned by `prompts/get` */
export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

/** the identity context a provider filters by (never a secret) */
export interface PromptSubject {
  subjectId: string;
  roles: string[];
}

/**
 * A host-injected prompt provider. `list` returns the descriptors visible to
 * the subject; `get` expands one (return `null` for an unknown name so the
 * engine can answer `prompt.notFound`). Both may be async.
 */
export interface PromptsProvider {
  list(ctx: PromptSubject): PromptDescriptor[] | Promise<PromptDescriptor[]>;
  get(name: string, args: Record<string, string>, ctx: PromptSubject): PromptResult | null | Promise<PromptResult | null>;
}

/** contract version for `PromptsProvider` implementers (stable seam) */
export const PROMPTS_API = 1;
