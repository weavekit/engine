export {
  ensureMetadataTable,
  readMetadataCache,
  writeMetadataCache,
  invalidateMetadata,
  syncMetadataCache,
} from './cache.js';
export type { MetadataRow, MetadataEntry } from './cache.js';
