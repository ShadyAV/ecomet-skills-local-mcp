import { randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    RESULT_STORAGE,
    LEGACY_RESULT_DIR,
    RESULT_ACTIVE_STALE_MS,
    RESULT_MAX_FILE_BYTES,
    RESULT_MAX_FILES,
    RESULT_MAX_TOTAL_BYTES,
    RESULT_RETENTION_MS,
} from './config.mjs';
import { requireStorageTarget } from './storage-layout.mjs';
import { createOwnedLockReleaseTracker, isTransientReleaseError } from './owned-lock-release.mjs';

const RESULT_JOB_ID_FILE_PART_LENGTH = 128;
const safeFilePart = (value) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, RESULT_JOB_ID_FILE_PART_LENGTH);

const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error)));
const ACTIVE_RESULT_PREFIX = '.active-';
const RESULT_PIN_PATTERN = /^\.result-owner-([1-9]\d{0,9})-[0-9a-f-]{36}\.pin$/;
const RESULT_LOCK_OWNER_PATTERN = /^([1-9]\d{0,9})-[0-9a-f-]{36}$/;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const ownedLockReleases = createOwnedLockReleaseTracker();
// Unique pins enter this tracker only after their response owner has ended.
const endedPinReleases = createOwnedLockReleaseTracker();
const isProcessAlive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code !== 'ESRCH'; }
};

// Same on-disk owner election as the artifact store: an in-process mutex cannot
// coordinate the separate MCP processes sharing this result directory.
const withResultStoreLock = async (resultDir, operation) => {
    const lockPath = join(resultDir, '.result-store.lock');
    await ownedLockReleases.retryPending(lockPath);
    let release;
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(resultDir, `.result-store-lock-${ownerId}`);
        await mkdir(candidatePath, { mode: 0o700 });
        try {
            await writeFile(join(candidatePath, ownerId), '', { flag: 'wx', mode: 0o600 });
            await rename(candidatePath, lockPath);
            release = async () => {
                await rm(join(lockPath, ownerId), { force: true });
                try { await rmdir(lockPath); }
                catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; }
            };
            break;
        } catch (error) {
            await rm(candidatePath, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
        }
        try {
            const before = await stat(lockPath);
            const owners = await readdir(lockPath, { withFileTypes: true });
            const ownerPids = owners.map(entry => {
                const match = entry.isFile() && RESULT_LOCK_OWNER_PATTERN.exec(entry.name);
                return match ? Number(match[1]) : null;
            });
            const liveOwner = ownerPids.some(pid => pid !== null && isProcessAlive(pid));
            // A fully published marker whose process has exited needs no grace.
            // Keep the age bound for empty/unknown ownership and never steal a live
            // section: otherwise primary crash recovery fails until the lock ages.
            const knownDeadOwner = ownerPids.length > 0 && ownerPids.every(pid => pid !== null) && !liveOwner;
            if (knownDeadOwner || Date.now() - before.mtimeMs > 30_000) {
                const current = await stat(lockPath);
                if (!liveOwner && current.dev === before.dev && current.ino === before.ino && current.mtimeMs === before.mtimeMs) {
                    const stalePath = join(resultDir, `.result-store-stale-${ownerId}`);
                    await rename(lockPath, stalePath);
                    await rm(stalePath, { recursive: true, force: true });
                }
            }
        } catch (error) {
            // Windows may report a sharing violation while the previous owner
            // removes/renames this directory. Retry election within its existing
            // bound; an unreadable snapshot never grants permission to reclaim it.
            if (!['ENOENT', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
        }
        await delay(25);
    }
    // Exhausting election is known contention, not an arbitrary operation failure.
    // Exact ended-owner cleanup must remain eligible for paced retry after this
    // live section ends; the live marker itself is never removed by the waiter.
    if (!release) throw Object.assign(new Error('Local result storage is busy; existing results have been preserved'), { code: 'EBUSY' });
    let operationError;
    try { return await operation(); }
    catch (error) { operationError = error; throw error; }
    finally {
        try { await ownedLockReleases.release(lockPath, release); }
        catch (error) { if (!operationError) throw error; }
    }
};
const ensurePrivateResultDirectory = async (resultDir) => {
    await mkdir(resultDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        await chmod(resultDir, 0o700);
    }
};
const ensurePrivateResultFile = async (resultPath) => {
    if (process.platform !== 'win32') {
        await chmod(resultPath, 0o600);
    }
};

const pruneResultsUnlocked = async ({
    resultDir = undefined,
    storageTarget = RESULT_STORAGE,
    now = Date.now(),
    retentionMs = RESULT_RETENTION_MS,
    activeStaleMs = RESULT_ACTIVE_STALE_MS,
    maxTotalBytes = RESULT_MAX_TOTAL_BYTES,
    maxFiles = RESULT_MAX_FILES,
    excludePaths = [],
} = {}) => {
    resultDir ??= requireStorageTarget(storageTarget, 'results');
    const errors = [];
    const excluded = new Set(excludePaths);
    await ensurePrivateResultDirectory(resultDir);
    let entries;
    try {
        entries = await readdir(resultDir, { withFileTypes: true });
    } catch (error) {
        return [normalizeError(error)];
    }

    // A published file remains pinned until its response owner emits the terminal
    // response. Retention is a cleanup quota, not a new admission quota: pending
    // responses may temporarily exceed it, just as active files already do.
    for (const entry of entries) {
        const match = entry.isFile() && RESULT_PIN_PATTERN.exec(entry.name);
        if (!match) continue;
        const pinPath = join(resultDir, entry.name);
        try {
            if (!isProcessAlive(Number(match[1]))) {
                await rm(pinPath, { force: true });
                continue;
            }
            const name = await readFile(pinPath, 'utf8');
            if (!/^[a-zA-Z0-9_-]+\.ndjson$/.test(name)) throw new Error('Result ownership marker is invalid');
            excluded.add(join(resultDir, name));
            excluded.add(join(resultDir, `${ACTIVE_RESULT_PREFIX}${name}`));
        } catch (error) {
            // Unknown ownership must not become permission to delete a result.
            return [normalizeError(error)];
        }
    }
    const files = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue;
        const path = join(resultDir, entry.name);
        try {
            await ensurePrivateResultFile(path);
            const metadata = await stat(path);
            const active = entry.name.startsWith(ACTIVE_RESULT_PREFIX);
            if (active && !excluded.has(path) && now - metadata.mtimeMs > activeStaleMs) {
                await rm(path, { force: true });
            } else if (!active && !excluded.has(path) && now - metadata.mtimeMs > retentionMs) {
                await rm(path, { force: true });
            } else if (!active) {
                files.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
            }
        } catch (error) {
            errors.push(normalizeError(error));
        }
    }

    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    let totalFiles = files.length;
    for (const file of files) {
        if (totalBytes <= maxTotalBytes && totalFiles <= maxFiles) break;
        if (excluded.has(file.path)) continue;
        try {
            await rm(file.path, { force: true });
            totalBytes -= file.size;
            totalFiles -= 1;
        } catch (error) {
            errors.push(normalizeError(error));
        }
    }
    return errors;
};

export const pruneResults = async (options = {}) => {
    const resultDir = options.resultDir ?? requireStorageTarget(options.storageTarget ?? RESULT_STORAGE, 'results');
    await ensurePrivateResultDirectory(resultDir);
    return withResultStoreLock(resultDir, () => pruneResultsUnlocked({ ...options, resultDir }));
};

export const pruneLegacyResults = async (options = {}) => {
    const resultDir = options.resultDir ?? LEGACY_RESULT_DIR;
    try {
        const metadata = await lstat(resultDir);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return [new Error('Legacy result directory is invalid')];
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        return [normalizeError(error)];
    }
    return pruneResults({ ...options, resultDir });
};

export const createJobWriter = async (
    jobId,
    {
        resultDir = undefined,
        storageTarget = RESULT_STORAGE,
        append = appendFile,
        maxFileBytes = RESULT_MAX_FILE_BYTES,
        retentionMs = RESULT_RETENTION_MS,
        activeStaleMs = RESULT_ACTIVE_STALE_MS,
        maxTotalBytes = RESULT_MAX_TOTAL_BYTES,
        maxFiles = RESULT_MAX_FILES,
    } = {}
) => {
    resultDir ??= requireStorageTarget(storageTarget, 'results');
    await ensurePrivateResultDirectory(resultDir);
    const retentionOptions = { resultDir, retentionMs, activeStaleMs, maxTotalBytes, maxFiles };
    const writeErrors = await pruneResults(retentionOptions);
    const resultName = `${safeFilePart(jobId)}-${randomUUID()}.ndjson`;
    const resultPath = join(resultDir, resultName);
    const activeResultPath = join(resultDir, `${ACTIVE_RESULT_PREFIX}${resultName}`);
    const pinPath = join(resultDir, `.result-owner-${process.pid}-${randomUUID()}.pin`);
    let setupStarted = false;
    try {
        await withResultStoreLock(resultDir, async () => {
            setupStarted = true;
            await writeFile(pinPath, resultName, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await writeFile(activeResultPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await ensurePrivateResultFile(activeResultPath);
        });
    } catch (error) {
        // A setup or lock-release failure returns no writer to the caller. Transfer
        // these invocation-unique paths to ended-owner cleanup, including partial writes.
        if (setupStarted) {
            try {
                await endedPinReleases.release(pinPath, async () => {
                    try {
                        await withResultStoreLock(resultDir, async () => {
                            await rm(activeResultPath, { force: true });
                            await rm(pinPath, { force: true });
                        });
                    } catch (cleanupError) {
                        // Deferred attempts run after the caller returned. Report a new
                        // nonretryable failure here without exposing filesystem paths.
                        if (!isTransientReleaseError(cleanupError)) {
                            console.error('RESULT_CLEANUP_FAILED: Failed result setup cleanup remains pending.');
                        }
                        throw cleanupError;
                    }
                });
            } catch (cleanupError) {
                if (!isTransientReleaseError(cleanupError)) {
                    const failure = new AggregateError([normalizeError(error), normalizeError(cleanupError)],
                        'Result writer setup failed and cleanup failed', { cause: error });
                    // The dispatcher diagnoses the setup error from its direct code;
                    // preserving both causes must not erase actionable ENOSPC guidance.
                    if (typeof error?.code === 'string') Object.defineProperty(failure, 'code', { value: error.code });
                    throw failure;
                }
                // A paced retry still owns these paths; retain the original setup error.
                console.error('RESULT_CLEANUP_FAILED: Failed result setup cleanup remains pending.');
            }
        }
        throw error;
    }
    let writeChain = Promise.resolve();
    let persistedBytes = 0;
    let fileLimitReached = false;
    let closed = false;
    let closePromise;
    let published = false;
    let released = false;
    return {
        resultPath,
        get published() { return published; },
        get persistedBytes() {
            return persistedBytes;
        },
        append(record) {
            if (closed) return Promise.resolve();
            writeChain = writeChain.then(async () => {
                try {
                    const serialized = `${JSON.stringify(record)}\n`;
                    const nextBytes = Buffer.byteLength(serialized);
                    if (persistedBytes + nextBytes > maxFileBytes) {
                        if (!fileLimitReached) {
                            fileLimitReached = true;
                            writeErrors.push(new Error(`Result exceeds the ${maxFileBytes}-byte per-file limit`));
                        }
                        return;
                    }
                    await append(activeResultPath, serialized, 'utf8');
                    persistedBytes += nextBytes;
                } catch (error) {
                    writeErrors.push(normalizeError(error));
                }
            });
            return writeChain;
        },
        close() {
            if (closePromise) return closePromise;
            closed = true;
            closePromise = (async () => {
                await writeChain;
                try {
                    await withResultStoreLock(resultDir, async () => {
                        await rename(activeResultPath, resultPath);
                        published = true;
                        await ensurePrivateResultFile(resultPath);
                        writeErrors.push(...(await pruneResultsUnlocked(retentionOptions)));
                    });
                } catch (error) {
                    writeErrors.push(normalizeError(error));
                }
                return [...writeErrors];
            })();
            return closePromise;
        },
        async release() {
            if (released) return;
            // Direct callers must close before releasing; dispatcher does this in
            // its response-finally path, including failed jobs with partial rows.
            await this.close();
            await endedPinReleases.release(pinPath, () => withResultStoreLock(resultDir, async () => {
                if (!published) await rm(activeResultPath, { force: true });
                await rm(pinPath, { force: true });
                released = true;
            }));
        },
    };
};
