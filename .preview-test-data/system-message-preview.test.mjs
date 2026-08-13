import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hookPath = fileURLToPath(new URL('../plugins/e-comet-skills/hooks/system-message-preview.mjs', import.meta.url));

const invokeHook = (dataDirectory, sessionId) => spawnSync(process.execPath, [hookPath], {
    encoding: 'utf8',
    env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dataDirectory,
        PLUGIN_DATA: dataDirectory,
    },
    input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        tool_name: 'mcp__e_comet_local__local_bridge_status',
    }),
});

test('shows the update once for a session and shows it again for another session', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'ecomet-preview-'));
    try {
        const first = invokeHook(dataDirectory, 'session-a');
        const repeated = invokeHook(dataDirectory, 'session-a');
        const another = invokeHook(dataDirectory, 'session-b');

        assert.equal(first.status, 0);
        assert.match(first.stdout, /"systemMessage"/);
        assert.match(first.stdout, /"additionalContext"/);
        assert.match(first.stdout, /плагина e-Comet MCP Tools/);
        assert.equal(repeated.status, 0);
        assert.equal(repeated.stdout, '');
        assert.equal(another.status, 0);
        assert.match(another.stdout, /"systemMessage"/);
    } finally {
        await rm(dataDirectory, { recursive: true, force: true });
    }
});
