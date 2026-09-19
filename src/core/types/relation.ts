import type { OnDeleteAction } from './fields.js';
import type { RELATION_KINDS } from './values.js';

export interface BelongsToEdge {
  kind: typeof RELATION_KINDS.BELONGS_TO;
  /** source object that holds the FK column */
  object: string;
  /** destination object the FK points to */
  target: string;
  /** column on `object` holding the FK value */
  foreignKey: string;
  required?: boolean;
  onDelete?: OnDeleteAction;
  /** true when derived from a `details` field (child→parent via parent_id) */
  details?: boolean;
}

export interface HasManyEdge {
  kind: typeof RELATION_KINDS.HAS_MANY;
  /** source object (the "one" side) */
  object: string;
  /** child object */
  target: string;
  /** column on `target` holding the FK back to `object` */
  foreignKey: string;
  /** true for master-detail (parent_id/parent_type/parent_idx mechanism) */
  details?: boolean;
  /** true when the FK column is an array (multiRelation reverse) */
  array?: boolean;
}

export interface MultiRelationEdge {
  kind: typeof RELATION_KINDS.MULTI_RELATION;
  /** source object holding the array column (e.g. customer) */
  object: string;
  /** referenced object (e.g. contact) */
  target: string;
  /** array column on `object` */
  foreignKey: string;
  required?: boolean;
}

/** union of all normalized relation edges in the relation graph */
export type RelationEdge = BelongsToEdge | HasManyEdge | MultiRelationEdge;
