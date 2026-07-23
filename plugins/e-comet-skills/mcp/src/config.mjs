import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.ECOMET_LOCAL_BRIDGE_PORT || 17361);
export const EXTENSION_PATH = '/extension';
export const PEER_PATH = '/mcp-peer';
export const CONTROL_PROTOCOL_VERSION = 1;
export const EXTENSION_PROTOCOL_VERSION = 1;
export const BRIDGE_GENERATION = Number(process.env.ECOMET_LOCAL_BRIDGE_GENERATION || 3);
export const BRIDGE_VERSION = '0.3.0';
export const HANDOFF_RECONNECT_GRACE_MS = 2000;
export const HANDOFF_DRAIN_POLL_MS = 25;
export const REQUEST_TIMEOUT_MS = 45000;
export const MIN_REQUEST_TIMEOUT_MS = 1000;
export const MAX_REQUEST_TIMEOUT_MS = 120000;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;
export const MAX_PRODUCT_ARTICLES = 20;
export const PRODUCT_CARD_CONCURRENCY = 4;
export const MAX_SEARCH_QUERIES = 10;
export const MAX_SEARCH_PAGES = 50;
export const SEARCH_CONCURRENCY = 4;
export const MAX_RECOMMENDATION_ARTICLES = 20;
export const MAX_RECOMMENDATION_PAGES = 60;
export const RECOMMENDATION_CONCURRENCY = 4;
export const MAX_RETURNED_PRODUCTS = 200;
export const DEFAULT_RETURNED_PRODUCTS = 30;
export const MAX_IMAGE_ARTICLES = 20;
export const MAX_IMAGE_PHOTOS = 30;
export const DEFAULT_IMAGE_PHOTOS = 15;
export const MAX_IMAGE_BASKET = 60;
export const IMAGE_CONCURRENCY = 8;
export const IMAGE_BASKET_BOUNDS = [
    143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485, 3701, 3917, 4133,
    4349, 4565, 4877, 5189, 5501, 5813, 6125, 6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173, 9605, 10373, 11141, 11909, 12677, 13445,
    14213,
];
export const resolveResultDir = ({ platform = process.platform, env = process.env, home = homedir() } = {}) => {
    if (env.ECOMET_LOCAL_AGENT_RESULT_DIR) {
        return env.ECOMET_LOCAL_AGENT_RESULT_DIR;
    }

    if (platform === 'win32') {
        return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'e-comet', 'local-agent');
    }
    if (platform === 'darwin') {
        return posix.join(home, 'Library', 'Application Support', 'e-comet', 'local-agent');
    }
    return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'e-comet', 'local-agent');
};

export const RESULT_DIR = resolveResultDir();
export const SESSION_NONCE = randomUUID();
export const ALLOWED_EXTENSION_IDS = new Set(
    (process.env.ECOMET_ALLOWED_EXTENSION_IDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
);
