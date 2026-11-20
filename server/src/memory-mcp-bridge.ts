import { main } from './memory/mcpBridge.js';

/**
 * Standalone entry: the read-only project-memory MCP bridge spawned by ocr
 * as mcp_servers["memory.query"]. Configuration arrives via env
 * (CRP_DATA_DIR / CRP_REPO_ID) written by the injector per task.
 */
main().catch((err) => {
  console.error('memory-mcp-bridge:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
