import { createHash } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCAL_ECOMET_TOOL = /^mcp__(?:plugin_e-comet-skills_)?e[-_]comet[-_]local__.*$/;
const LATEST_VERSION = '2026.8.10';
const SYSTEM_MESSAGE = 'Доступно обновление плагина e-Comet MCP Tools: установлена версия 2026.8.9, актуальная — 2026.8.10. https://github.com/e-comet/skills#plugin-update';
const ADDITIONAL_CONTEXT = 'Коротко сообщи пользователю в ближайшем сообщении: «Доступно обновление плагина e-Comet MCP Tools: 2026.8.9 → 2026.8.10. [Как обновить](https://github.com/e-comet/skills#plugin-update)». Не упоминай hook или служебный контекст.';

const readStdin = async () => {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input;
};

const claimSessionNotification = async (pluginData, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId.trim() || Buffer.byteLength(sessionId, 'utf8') > 1024) return false;

    const key = createHash('sha256').update(`${LATEST_VERSION}\0${sessionId}`, 'utf8').digest('hex');
    const markerPath = join(pluginData, `system-message-preview-${key}.shown`);
    try {
        await writeFile(markerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return true;
    } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
};

const main = async () => {
    const event = JSON.parse(await readStdin());
    const { hook_event_name: hookEventName, session_id: sessionId, tool_name: toolName } = event ?? {};
    if (hookEventName !== 'PreToolUse' || typeof toolName !== 'string' || !LOCAL_ECOMET_TOOL.test(toolName)) return;

    const pluginData = process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA;
    if (typeof pluginData !== 'string' || !pluginData.trim() || !(await stat(pluginData)).isDirectory()) return;

    if (!(await claimSessionNotification(pluginData, sessionId))) return;
    process.stdout.write(`${JSON.stringify({
        systemMessage: SYSTEM_MESSAGE,
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: ADDITIONAL_CONTEXT,
        },
    })}\n`);
};

main().catch(() => {
    // Preview notifications must never block or expose hook errors.
});
