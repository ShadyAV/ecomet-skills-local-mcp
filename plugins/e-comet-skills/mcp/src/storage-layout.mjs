import { posix, win32 } from 'node:path';

const OUTPUT_SUBTREE = 'local-mcp-output-v2';
const UNEXPANDED_PATH = /(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%|^~(?:[\\/]|$))/;

const pathApi = (platform) => (platform === 'win32' ? win32 : posix);
const unavailable = (reason) => Object.freeze({ state: 'unavailable', reason });

export class StorageUnavailableError extends Error {
    constructor(store, reason) {
        super('Local output storage is unavailable.');
        this.name = 'StorageUnavailableError';
        this.code = 'LOCAL_STORAGE_UNAVAILABLE';
        this.stage = 'storage';
        this.retryable = false;
        this.store = store;
        this.reason = reason;
    }
}

export const requireStorageTarget = (target, store) => {
    if (target?.state === 'ready') return target.path;
    throw new StorageUnavailableError(store, target?.reason ?? 'plugin_data_invalid');
};

const normalizedAbsolutePath = (value, platform) => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed !== value || UNEXPANDED_PATH.test(trimmed)) return undefined;
    const api = pathApi(platform);
    if (!api.isAbsolute(trimmed)) return undefined;
    return api.resolve(trimmed);
};

const identity = (value, platform) => (platform === 'win32' ? value.toLowerCase() : value);

export const resolvePluginDataRoot = (env = process.env, platform = process.platform) => {
    const candidates = [env?.PLUGIN_DATA, env?.CLAUDE_PLUGIN_DATA]
        .filter((value) => typeof value === 'string' && value.trim().length > 0);
    if (candidates.length === 0) return unavailable('plugin_data_missing');
    const normalized = candidates.map((value) => normalizedAbsolutePath(value, platform));
    if (normalized.some((value) => value === undefined)) return unavailable('plugin_data_invalid');
    if (new Set(normalized.map((value) => identity(value, platform))).size !== 1) {
        return unavailable('plugin_data_conflict');
    }
    return Object.freeze({ state: 'ready', path: normalized[0] });
};

export const explicitOrPluginTarget = (explicitValue, pluginRoot, childName, platform = process.platform) => {
    if (typeof explicitValue === 'string' && explicitValue.trim().length > 0) {
        const path = normalizedAbsolutePath(explicitValue, platform);
        return path === undefined
            ? unavailable('override_invalid')
            : Object.freeze({ state: 'ready', backend: 'override', path });
    }
    if (pluginRoot.state !== 'ready') return pluginRoot;
    const path = pathApi(platform).join(pluginRoot.path, OUTPUT_SUBTREE, childName);
    return Object.freeze({ state: 'ready', backend: 'plugin_data', path });
};

export const resolveStorageLayout = ({ env = process.env, platform = process.platform } = {}) => {
    const pluginRoot = resolvePluginDataRoot(env, platform);
    return Object.freeze({
        results: explicitOrPluginTarget(env?.ECOMET_LOCAL_AGENT_RESULT_DIR, pluginRoot, 'results', platform),
        marketplaceArtifacts: explicitOrPluginTarget(
            env?.ECOMET_LOCAL_AGENT_ARTIFACT_DIR,
            pluginRoot,
            'marketplace-artifacts',
            platform
        ),
        feedbackArtifacts: explicitOrPluginTarget(
            env?.ECOMET_FEEDBACK_ARTIFACT_DIR,
            pluginRoot,
            'feedback-artifacts',
            platform
        ),
    });
};

export const storageStatus = (layout) =>
    Object.fromEntries(
        Object.entries(layout).map(([name, target]) => [
            name,
            target.state === 'ready'
                ? Object.freeze({ state: target.state, backend: target.backend })
                : Object.freeze({ state: target.state, reason: target.reason }),
        ])
    );
