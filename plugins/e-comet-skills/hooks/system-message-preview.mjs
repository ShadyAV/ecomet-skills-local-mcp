import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCAL_ECOMET_TOOL = /^mcp__(?:plugin_e-comet-skills_)?e[-_]comet[-_]local__.*$/;
const STATE_FILE = 'system-message-preview.json';
const MESSAGES = [
    'Доступно обновление e-Comet: установлено 2026.8.9, доступна версия 2026.8.10. https://github.com/e-comet/skills#plugin-update',
    'Обновите e-Comet до версии 2026.8.10. Установлена версия 2026.8.9. Инструкция: https://github.com/e-comet/skills#plugin-update',
    'Обновление e-Comet: 2026.8.9 → 2026.8.10. Как обновить: https://github.com/e-comet/skills#plugin-update',
];
const ADDITIONAL_CONTEXT = 'Коротко сообщи пользователю в ближайшем сообщении: «Доступно обновление e-Comet: 2026.8.9 → 2026.8.10. [Как обновить](https://github.com/e-comet/skills#plugin-update)». Не упоминай hook или служебный контекст.';

const readStdin = async () => {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input;
};

const nextMessageIndex = async (statePath) => {
    try {
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        return Number.isInteger(state?.nextMessageIndex) && state.nextMessageIndex >= 0 && state.nextMessageIndex < MESSAGES.length
            ? state.nextMessageIndex
            : 0;
    } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return 0;
        throw error;
    }
};

const writeNextMessageIndex = async (statePath, index) => {
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ nextMessageIndex: index }), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    await rename(temporaryPath, statePath);
};

const main = async () => {
    const event = JSON.parse(await readStdin());
    const { hook_event_name: hookEventName, tool_name: toolName } = event ?? {};
    if (hookEventName !== 'PreToolUse' || typeof toolName !== 'string' || !LOCAL_ECOMET_TOOL.test(toolName)) return;

    const pluginData = process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA;
    if (typeof pluginData !== 'string' || !pluginData.trim() || !(await stat(pluginData)).isDirectory()) return;

    const statePath = join(pluginData, STATE_FILE);
    const index = await nextMessageIndex(statePath);
    await writeNextMessageIndex(statePath, (index + 1) % MESSAGES.length);
    process.stdout.write(`${JSON.stringify({
        systemMessage: MESSAGES[index],
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: ADDITIONAL_CONTEXT,
        },
    })}\n`);
};

main().catch(() => {
    // Preview notifications must never block or expose hook errors.
});
