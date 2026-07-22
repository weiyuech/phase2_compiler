/**
 * knowledge/index.js
 *
 * KnowledgeBaseProvider — abstract interface + factory
 *
 * Any provider must implement:
 *   getContent(mapName, pathName, goalId, goalObject?)
 *     → Promise<{ body?, mp3_file?, goal_object? } | null>
 *     Lookup order: specific (goalObject) → generic (goalObject='')
 *   saveEntry(mapName, pathName, goalId, { goal_object?, body?, mp3_file? }) → Promise<void>
 *   deleteEntry(mapName, pathName, goalId, goalObject?)  → Promise<void>
 *   listMaps()                                           → Promise<string[]>
 *   listPaths(mapName)                                   → Promise<string[]>
 *   listPoints(mapName, pathName)                        → Promise<string[]>
 *     Returns composite keys: "1" for generic, "1-car" for object-specific
 *   healthCheck()                                        → Promise<boolean>
 */

export async function createKnowledgeBaseProvider(config = {}) {
  const { FlatFileProvider } = await import('./flatfile-provider.js')
  return new FlatFileProvider({
    dir: config.KB_FLATFILE_DIR || process.env.KB_FLATFILE_DIR || './data/flatfiles'
  })
}
