// Test-marketplace adapter for hosts that do not pass plugin data to legacy MCP servers.
// Authorization remains exclusively in the existing trusted host hooks.
import { homedir } from 'node:os';
import { join } from 'node:path';

if (!process.env.PLUGIN_DATA && !process.env.CLAUDE_PLUGIN_DATA) {
    const root = join(homedir(), '.e-comet', 'test-plugin-output', 'e-comet-skills');
    for (const [key, child] of [
        ['ECOMET_LOCAL_AGENT_RESULT_DIR', 'results'],
        ['ECOMET_LOCAL_AGENT_ARTIFACT_DIR', 'marketplace-artifacts'],
        ['ECOMET_FEEDBACK_ARTIFACT_DIR', 'feedback-artifacts'],
    ]) {
        if (process.env[key] === undefined) process.env[key] = join(root, child);
    }
}
await import('../mcp/src/server.mjs');
