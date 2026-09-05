import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { MAX_MCP_MESSAGE_BYTES } from './config.mjs';
import { resolvePeerTokenDir } from './state-paths.mjs';
import { safeFeedbackProperty, withFeedbackOperation } from './feedback-diagnostics.mjs';

const CLAIM_DIRECTORY_NAME = 'feedback-local-claims-v1';
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const CLAIM_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_HASH_PATTERN = /^[a-f0-9]{64}$/;
const CLAIM_CONTEXT = 'e-comet-feedback-local-claim-v1';
const CLAIM_VERSION = 1;
const MAX_CLAIM_BYTES = 4 * 1024;
// WHY: a valid 48 KiB grant gains at most 160 bytes when the hook adds the fixed UUID,
// eight-digit archive size, and SHA-256 submit envelope. Keep bounded headroom so every
// accepted grant can be claimed without increasing the persisted 4 KiB hash-only record.
const MAX_SUBMIT_BINDING_BYTES = 48 * 1024 + 256;
const MAX_SESSION_BYTES = 512;
// Counts pending claims and recent one-use guard tombstones: this is a physical store bound,
// not a count of currently usable authorizations.
const MAX_CLAIM_STORE_ENTRIES = 128;
const MAX_CLAIM_TTL_MS = 60_000;
const CLAIM_CLOCK_SKEW_MS = 5_000;
const STALE_TEMPORARY_MS = 5 * 60_000;
const CLAIM_LOCK_STALE_MS = 30_000;
const CLAIM_LOCK_RETRY_LIMIT = 200;
const CLAIM_LOCK_RETRY_MS = 10;
const CLAIM_LOCK_RESIDUE_PATTERN = /^\.(?:claim-store-lock|stale-lock)-([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TARGET_TOOLS = new Set(['prepare_e_comet_feedback', 'submit_e_comet_feedback']);

class FeedbackClaimError extends Error {
    constructor(reason, cause) {
        super('The trusted feedback handoff claim could not be verified.', { cause });
        this.name = 'FeedbackClaimError';
        this.code = 'FEEDBACK_CLAIM_INVALID';
        this.feedbackReason = reason;
    }
}

const invalidClaim = (reason, cause) => new FeedbackClaimError(reason, cause);
const claimFailure = (error, operation) => withFeedbackOperation(
    error instanceof FeedbackClaimError ? error : invalidClaim(undefined, error), operation,
);
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const canonicalize = (value, depth = 0) => {
    if (depth > 8) throw invalidClaim();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw invalidClaim();
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 64) throw invalidClaim();
        return value.map((item) => canonicalize(item, depth + 1));
    }
    if (!isRecord(value) || Object.keys(value).length > 64) throw invalidClaim();
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalize(value[key], depth + 1)]),
    );
};

const inputBinding = (input, maximumBytes) => {
    if (!isRecord(input)) throw invalidClaim();
    let serialized;
    try {
        serialized = JSON.stringify(canonicalize(input));
    } catch (error) {
        if (error?.code === 'FEEDBACK_CLAIM_INVALID') throw error;
        throw invalidClaim();
    }
    if (byteLength(serialized) > maximumBytes) throw invalidClaim();
    return sha256(serialized);
};

const validateTargetTool = (targetTool) => {
    if (!TARGET_TOOLS.has(targetTool)) throw invalidClaim();
    return targetTool;
};

const maximumBindingBytes = (targetTool) =>
    targetTool === 'prepare_e_comet_feedback' ? MAX_MCP_MESSAGE_BYTES : MAX_SUBMIT_BINDING_BYTES;

const validateClock = (now) => {
    const nowMs = typeof now === 'function' ? now() : Number.NaN;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw invalidClaim();
    return nowMs;
};

export const resolveFeedbackClaimDirectory = (env = process.env) => {
    const configuredHome = env?.USERPROFILE || env?.HOME;
    const configuredStateRoot = env?.LOCALAPPDATA || env?.XDG_DATA_HOME || configuredHome;
    const pluginData = env?.CLAUDE_PLUGIN_DATA || env?.PLUGIN_DATA;
    if ((!configuredStateRoot || typeof configuredStateRoot !== 'string') && typeof pluginData === 'string' && pluginData.trim()) {
        return join(resolve(pluginData), CLAIM_DIRECTORY_NAME);
    }
    const sharedStateDirectory = resolvePeerTokenDir({
        env,
        ...(typeof configuredHome === 'string' && configuredHome.trim() ? { home: resolve(configuredHome) } : {}),
    });
    return join(sharedStateDirectory, CLAIM_DIRECTORY_NAME);
};

const ensurePrivateDirectory = async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalidClaim();
    if (process.platform !== 'win32') await chmod(directory, 0o700);
};

const acquireClaimStoreLock = async (directory) => {
    const lockPath = join(directory, '.feedback-claim-store.lock');
    const deadline = performance.now() + CLAIM_LOCK_RETRY_LIMIT * CLAIM_LOCK_RETRY_MS;
    for (let attempt = 0; attempt < CLAIM_LOCK_RETRY_LIMIT && performance.now() < deadline; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(directory, `.claim-store-lock-${ownerId}`);
        await mkdir(candidatePath, { mode: 0o700 });
        try {
            await writeFile(join(candidatePath, ownerId), '', { mode: 0o600, flag: 'wx' });
            await rename(candidatePath, lockPath);
            return async () => {
                // An old owner can remove only its own marker, never a successor's directory contents.
                await rm(join(lockPath, ownerId), { force: true });
                try { await rmdir(lockPath); }
                catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(safeFeedbackProperty(error, 'code'))) throw error; }
            };
        } catch (error) {
            await rm(candidatePath, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY'].includes(safeFeedbackProperty(error, 'code'))) throw error;
        }
        try {
            const before = await stat(lockPath);
            if (Date.now() - before.mtimeMs > CLAIM_LOCK_STALE_MS) {
                const owners = await readdir(lockPath, { withFileTypes: true });
                const protectedOwner = owners.some(entry => {
                    const match = entry.isFile() && /^([1-9]\d{0,9})-[0-9a-f-]{36}$/.exec(entry.name);
                    if (!match) return false;
                    try { process.kill(Number(match[1]), 0); return true; }
                    catch (error) { return safeFeedbackProperty(error, 'code') !== 'ESRCH'; }
                });
                if (protectedOwner) { await delay(CLAIM_LOCK_RETRY_MS); continue; }
                const stalePath = join(directory, `.stale-lock-${process.pid}-${randomUUID()}`);
                try {
                    const current = await stat(lockPath);
                    if (current.dev === before.dev && current.ino === before.ino && current.mtimeMs === before.mtimeMs) {
                        await rename(lockPath, stalePath);
                        await rm(stalePath, { recursive: true, force: true });
                        continue;
                    }
                } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        await delay(CLAIM_LOCK_RETRY_MS);
    }
    throw invalidClaim('claim_store_busy');
};

const withClaimStoreLock = async (directory, operation) => {
    const release = await acquireClaimStoreLock(directory);
    let failed = false;
    try {
        return await operation();
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        try {
            await release();
        } catch (error) {
            if (!failed) throw error;
        }
    }
};

const safeEqual = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBytes = Buffer.from(left, 'utf8');
    const rightBytes = Buffer.from(right, 'utf8');
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const signPayload = (claimToken, payload) =>
    createHmac('sha256', claimToken)
        .update(CLAIM_CONTEXT, 'utf8')
        .update('\0')
        .update(JSON.stringify(payload), 'utf8')
        .digest('base64url');

const validPayload = (payload) =>
    isRecord(payload) &&
    Object.keys(payload).sort().join('\0') ===
        ['createdAtMs', 'expiresAtMs', 'inputHash', 'sessionHash', 'targetTool', 'tokenHash', 'version']
            .sort()
            .join('\0') &&
    payload.version === CLAIM_VERSION &&
    Number.isSafeInteger(payload.createdAtMs) &&
    payload.createdAtMs >= 0 &&
    Number.isSafeInteger(payload.expiresAtMs) &&
    payload.expiresAtMs > payload.createdAtMs &&
    CLAIM_HASH_PATTERN.test(payload.inputHash) &&
    CLAIM_HASH_PATTERN.test(payload.sessionHash) &&
    TARGET_TOOLS.has(payload.targetTool) &&
    CLAIM_HASH_PATTERN.test(payload.tokenHash);

const readClaimRecord = async (path) => {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_CLAIM_BYTES) {
        throw invalidClaim();
    }
    const bytes = await readFile(path);
    if (bytes.length < 1 || bytes.length > MAX_CLAIM_BYTES) throw invalidClaim('claim_record_invalid');
    let record;
    try {
        record = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw invalidClaim('claim_record_invalid', error);
    }
    if (
        !isRecord(record) ||
        Object.keys(record).sort().join('\0') !== ['payload', 'signature'].sort().join('\0') ||
        !validPayload(record.payload) ||
        typeof record.signature !== 'string' ||
        !CLAIM_SIGNATURE_PATTERN.test(record.signature)
    ) {
        throw invalidClaim('claim_record_invalid');
    }
    return record;
};

const cleanupClaimDirectory = async (directory, nowMs) => {
    const entries = await readdir(directory, { withFileTypes: true });
    let active = 0;
    for (const entry of entries) {
        const path = join(directory, entry.name);
        const lockResidue = CLAIM_LOCK_RESIDUE_PATTERN.exec(entry.name);
        if (lockResidue) {
            let removed = false;
            // Candidate/quarantine names carry their creator PID even if it died before writing a marker.
            // Only positively dead owners may be reclaimed; age cannot displace a stalled live hook.
            if (entry.isDirectory()) {
                let dead = false;
                try { process.kill(Number(lockResidue[1]), 0); }
                catch (error) { dead = safeFeedbackProperty(error, 'code') === 'ESRCH'; }
                if (dead) {
                    try { await rm(path, { recursive: true, force: true }); removed = true; }
                    catch (error) { removed = safeFeedbackProperty(error, 'code') === 'ENOENT'; }
                }
            }
            // Unreadable, unremovable, live, and unknown-owner residues never bypass admission accounting.
            if (!removed) active += 1;
            continue;
        }
        if (entry.isFile() && CLAIM_FILE_PATTERN.test(entry.name)) {
            let expired = false;
            try {
                const record = await readClaimRecord(path);
                expired = record.payload.expiresAtMs <= nowMs;
            } catch (error) {
                // A failed filesystem read proves neither corruption nor expiry. Retain and count it.
                expired = error instanceof FeedbackClaimError;
            }
            if (expired) await rm(path, { force: true });
            else active += 1;
            continue;
        }
        if (entry.isFile() && /^\.(?:stage|claimed)-/.test(entry.name)) {
            let removed = false;
            try {
                const metadata = await stat(path);
                if (metadata.mtimeMs <= nowMs - STALE_TEMPORARY_MS) {
                    await rm(path, { force: true });
                    removed = true;
                }
            } catch (error) {
                removed = safeFeedbackProperty(error, 'code') === 'ENOENT';
            }
            // Guards/residues never grant authority but retain a bounded physical slot until removed.
            if (!removed) active += 1;
        }
    }
    if (active >= MAX_CLAIM_STORE_ENTRIES) throw invalidClaim('claim_capacity');
};

/**
 * Publishes a short-lived hook-created capability without persisting the raw session, path, or upload grant.
 * @param {{ sessionId: string, targetTool: string, input: Record<string, unknown> }} claim
 * @param {{ claimDirectory?: string, env?: NodeJS.ProcessEnv, now?: () => number, ttlMs?: number }} options
 * @returns {Promise<{ claimToken: string, sessionBinding: string }>}
 */
export const issueFeedbackClaim = async (claim, options = {}) => {
    try {
        const nowMs = validateClock(options.now ?? Date.now);
        const ttlMs = options.ttlMs ?? MAX_CLAIM_TTL_MS;
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_CLAIM_TTL_MS) throw invalidClaim();
        if (!isRecord(claim) || typeof claim.sessionId !== 'string' || byteLength(claim.sessionId) < 1 || byteLength(claim.sessionId) > MAX_SESSION_BYTES) {
            throw invalidClaim();
        }
        const targetTool = validateTargetTool(claim.targetTool);
        const inputHash = inputBinding(claim.input, maximumBindingBytes(targetTool));
        const claimDirectory = options.claimDirectory ?? resolveFeedbackClaimDirectory(options.env ?? process.env);
        await ensurePrivateDirectory(claimDirectory);
        return await withClaimStoreLock(claimDirectory, async () => {
            await cleanupClaimDirectory(claimDirectory, nowMs);

            const claimToken = randomBytes(32).toString('base64url');
            const tokenHash = sha256(claimToken);
            const payload = {
                version: CLAIM_VERSION,
                createdAtMs: nowMs,
                expiresAtMs: nowMs + ttlMs,
                sessionHash: sha256(claim.sessionId),
                targetTool,
                tokenHash,
                inputHash,
            };
            const record = { payload, signature: signPayload(claimToken, payload) };
            const serialized = `${JSON.stringify(record)}\n`;
            if (byteLength(serialized) > MAX_CLAIM_BYTES) throw invalidClaim();
            const stagePath = join(claimDirectory, `.stage-${process.pid}-${randomUUID()}`);
            const finalPath = join(claimDirectory, `${tokenHash}.json`);
            await writeFile(stagePath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            try {
                if (process.platform !== 'win32') await chmod(stagePath, 0o600);
                await rename(stagePath, finalPath);
            } finally {
                await rm(stagePath, { force: true }).catch(() => undefined);
            }
            return { claimToken, sessionBinding: payload.sessionHash };
        });
    } catch (error) {
        throw claimFailure(error, 'claim_issue');
    }
};

/**
 * Atomically removes and verifies one exact claim before its bound local operation may perform protected I/O.
 * @param {{ claimToken?: string, sessionBinding?: string, targetTool: string, input: Record<string, unknown> }} claim
 * @param {{ claimDirectory?: string, env?: NodeJS.ProcessEnv, now?: () => number }} options
 */
export const consumeFeedbackClaim = async (claim, options = {}) => {
    let claimedPath;
    try {
        validateClock(options.now ?? Date.now);
        if (
            !isRecord(claim) ||
            typeof claim.claimToken !== 'string' ||
            !CLAIM_TOKEN_PATTERN.test(claim.claimToken) ||
            typeof claim.sessionBinding !== 'string' ||
            !CLAIM_HASH_PATTERN.test(claim.sessionBinding)
        ) throw invalidClaim();
        const targetTool = validateTargetTool(claim.targetTool);
        const inputHash = inputBinding(claim.input, maximumBindingBytes(targetTool));
        const tokenHash = sha256(claim.claimToken);
        const claimDirectory = options.claimDirectory ?? resolveFeedbackClaimDirectory(options.env ?? process.env);
        const pendingPath = join(claimDirectory, `${tokenHash}.json`);
        // WHY: a nonexistent token must not accumulate tombstones; metadata access grants no authority.
        try {
            await lstat(pendingPath);
        } catch (error) {
            if (safeFeedbackProperty(error, 'code') !== 'ENOENT') throw error;
            const consumed = await lstat(join(claimDirectory, `.claimed-guard-${tokenHash}`)).then(() => true, error => {
                if (safeFeedbackProperty(error, 'code') !== 'ENOENT') throw error;
                return false;
            });
            throw invalidClaim(consumed ? 'claim_already_consumed' : 'claim_missing', error);
        }
        // WHY: native Windows rename can succeed for multiple consumers. CREATE_NEW elects the sole owner first.
        // A successful wx irreversibly consumes the claim even if a later transition fails; recovery needs a fresh claim.
        // Never unlink this guard from a consumer: a stalled owner must not remove a later guard after housekeeping.
        // Existing .claimed-* housekeeping reclaims it after five minutes, beyond the one-minute claim lifetime.
        try {
            await writeFile(join(claimDirectory, `.claimed-guard-${tokenHash}`), '', { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (safeFeedbackProperty(error, 'code') === 'EEXIST') throw invalidClaim('claim_already_consumed', error);
            throw error;
        }
        claimedPath = join(claimDirectory, `.claimed-${process.pid}-${randomUUID()}`);
        await rename(pendingPath, claimedPath);
        const record = await readClaimRecord(claimedPath);
        const valid =
            safeEqual(record.payload.tokenHash, tokenHash) &&
            safeEqual(record.payload.sessionHash, claim.sessionBinding) &&
            safeEqual(record.payload.inputHash, inputHash) &&
            record.payload.targetTool === targetTool;
        if (!valid) throw invalidClaim('claim_binding_mismatch');
        if (!safeEqual(record.signature, signPayload(claim.claimToken, record.payload))) throw invalidClaim('claim_signature_invalid');
        await rm(claimedPath, { force: true }).catch(() => undefined);
        claimedPath = undefined;
        // WHY: even owned-record cleanup can stall beyond expiry; no awaited work may follow the final time check.
        const nowMs = validateClock(options.now ?? Date.now);
        if (record.payload.createdAtMs > nowMs + CLAIM_CLOCK_SKEW_MS) throw invalidClaim('claim_not_yet_valid');
        if (record.payload.expiresAtMs <= nowMs) throw invalidClaim('claim_expired');
    } catch (error) {
        throw claimFailure(error, 'claim_consume');
    } finally {
        if (claimedPath) await rm(claimedPath, { force: true }).catch(() => undefined);
    }
};
