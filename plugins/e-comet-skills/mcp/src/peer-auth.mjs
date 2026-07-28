import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCAL_STATE_DIR } from './config.mjs';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_FILE = '.peer-token';
const PEER_AUTH_CONTEXT = 'e-comet-local-peer-auth-v1';

const normalizeToken = (value) => value.trim();
const restrictExistingTokenPermissions = async (tokenPath) => {
    if (process.platform === 'win32') {
        await chmod(tokenPath, 0o600).catch(() => undefined);
        return;
    }
    await chmod(tokenPath, 0o600);
};

export const peerTokensEqual = (actual, expected) => {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false;
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

export const createPeerAuthNonce = () => randomBytes(32).toString('base64url');

export const isValidPeerAuthNonce = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);

export const createPeerAuthProof = (peerToken, role, transcript) =>
    createHmac('sha256', peerToken)
        .update(PEER_AUTH_CONTEXT)
        .update('\0')
        .update(role)
        .update('\0')
        .update(transcript)
        .digest('base64url');

export const loadOrCreatePeerToken = async ({ directory = LOCAL_STATE_DIR } = {}) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        await chmod(directory, 0o700);
    }
    const tokenPath = join(directory, TOKEN_FILE);
    try {
        const existing = normalizeToken(await readFile(tokenPath, 'utf8'));
        if (!TOKEN_PATTERN.test(existing)) {
            await rm(tokenPath, { force: true });
            return loadOrCreatePeerToken({ directory });
        }
        await restrictExistingTokenPermissions(tokenPath);
        return existing;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const token = randomBytes(32).toString('base64url');
    try {
        const handle = await open(tokenPath, 'wx', 0o600);
        try {
            await handle.writeFile(`${token}\n`, 'utf8');
        } finally {
            await handle.close();
        }
        return token;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            const existing = normalizeToken(await readFile(tokenPath, 'utf8'));
            if (TOKEN_PATTERN.test(existing)) return existing;
        }
        throw new Error('Local peer token was not initialized');
    }
};
