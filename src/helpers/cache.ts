/**
 * Cache Helper Functions
 * 
 * Single Responsibility: Handle D1CV cache purging operations
 */

/**
 * Purge D1CV cache for a specific entity type
 * Called after successful mutations to invalidate cached responses
 */
export async function purgeD1CVCache(d1cvUrl: string, entityType?: string): Promise<void> {
  try {
    const purgeUrl = entityType
      ? `${d1cvUrl}/api/cache/purge/${entityType}`
      : `${d1cvUrl}/api/cache/purge`;

    const response = await fetch(purgeUrl, { method: 'POST' });
    if (!response.ok) {
      console.warn(`Cache purge failed: ${response.status}`);
    } else {
      const result = await response.json() as { purged: number };
      console.log(`Cache purged: ${result.purged} entries for ${entityType || 'all'}`);
    }
  } catch (error) {
    // Don't fail the mutation if cache purge fails
    console.error('Cache purge error (non-fatal):', error);
  }
}
