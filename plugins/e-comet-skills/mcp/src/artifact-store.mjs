import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    ARTIFACT_STORAGE,
    LEGACY_ARTIFACT_DIR,
    ARTIFACT_MAX_CHUNK_BYTES,
    ARTIFACT_MAX_FILE_BYTES,
    ARTIFACT_MAX_FILES,
    ARTIFACT_MAX_JOB_BYTES,
    ARTIFACT_MAX_TOTAL_BYTES,
    ARTIFACT_RETENTION_MS,
} from './config.mjs';
import { requireStorageTarget } from './storage-layout.mjs';
import { assertXlsxPackage } from './xlsx-package.mjs';
import { ArtifactSetupCleanupPendingError } from './tool-errors.mjs';
import { createOwnedLockReleaseTracker } from './owned-lock-release.mjs';
import { classifyProcessOwner, getOwnProcessIdentity, hasComparableProcessScope, isDifferentProcess, readCurrentProcessScope, readProcessIdentity } from './process-identity.mjs';

const defaultFileSystem = { appendFile, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile };
const jobUsage = new Map();
const activePartPaths = new Set();
const pendingSetupCleanups = createOwnedLockReleaseTracker();
// Do not expire this gate: elapsed time cannot discharge exact file ownership,
// and new failed setups could otherwise accumulate outside the byte quota.
// Retry work is bounded by the tracker; successful cleanup reopens admission.
const settlePendingSetupCleanups = async artifactDir => {
    try { await pendingSetupCleanups.retryPending(artifactDir); }
    catch (cause) { throw new ArtifactSetupCleanupPendingError(cause); }
};
// Failed setup must settle the exact job's pendingCleanups and deferred release;
// a disk sweep cannot infer that ownership. Group exact obligations by root so
// admission retries all of them without a second directory-to-path index.
const ARTIFACT_LOCK_RETRY_LIMIT = 200;
const ARTIFACT_LOCK_RETRY_DELAY_MS = 25;
const ARTIFACT_LOCK_STALE_MS = 30_000;
const ARTIFACT_PIN_REMOVE_RETRY_LIMIT = 3;
const ARTIFACT_DEFERRED_RELEASE_RETRY_LIMIT = 3;
const ARTIFACT_DEFERRED_RELEASE_RETRY_DELAY_MS = 1_000;
const ARTIFACT_CLEANUP_RETRY_LIMIT = 3;
const ARTIFACT_CLEANUP_RETRY_DELAY_MS = 1_000;
const TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RETRYABLE_ARTIFACT_RELEASE_ERRORS = new Set([...TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS, 'ARTIFACT_STORE_BUSY']);
const ARTIFACT_LOCK_OWNER_PATTERN = /^([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const asError = (error) => (error instanceof Error ? error : new Error(String(error)));
export class ArtifactStoreError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'ArtifactStoreError';
        this.code = code;
        if (options.retryable !== undefined) this.retryable = options.retryable === true;
    }
}
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const ensurePrivateDirectory = async (directory, fileSystem = defaultFileSystem, platform = process.platform) => {
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    if (platform !== 'win32') await fileSystem.chmod(directory, 0o700);
};
const ensurePrivateFile = async (path, fileSystem = defaultFileSystem, platform = process.platform) => {
    if (platform !== 'win32') await fileSystem.chmod(path, 0o600);
};
const safeArtifactName = (fileName) => {
    if (typeof fileName !== 'string' || fileName.length === 0) throw new Error('Artifact file name is required');
    const sanitized = basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 180);
    const baseName = sanitized || 'artifact';
    return baseName.toLowerCase().endsWith('.xlsx') ? baseName : `${baseName}.xlsx`;
};
const decodeCanonicalBase64 = (base64Data, maxChunkBytes) => {
    if (typeof base64Data !== 'string' || base64Data.length === 0) throw new Error('Artifact chunk must use canonical base64');
    const maximumEncodedLength = Math.ceil(maxChunkBytes / 3) * 4;
    if (base64Data.length > maximumEncodedLength) throw new Error(`Artifact encoded chunk exceeds the ${maximumEncodedLength}-byte chunk limit`);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64Data)) {
        throw new Error('Artifact chunk must use canonical base64');
    }
    const bytes = Buffer.from(base64Data, 'base64');
    if (bytes.toString('base64') !== base64Data) throw new Error('Artifact chunk must use canonical base64');
    return bytes;
};
const validateLimits = ({ maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs }) => {
    if (![maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs].every(isPositiveSafeInteger)) {
        throw new Error('Artifact limits must be positive safe integers');
    }
};
const acquireJob = (jobId, maxJobBytes) => {
    const usage = jobUsage.get(jobId) || {
        bytes: 0,
        writers: 0,
        pendingCleanups: 0,
        maxJobBytes,
        pinGroups: new Map(),
        deferredReleaseAttempts: 0,
        releaseRetryScheduled: false,
        deferredRelease: undefined,
    };
    usage.writers += 1;
    jobUsage.set(jobId, usage);
    return usage;
};
const ACTIVE_PART_PATTERN = /^\.active-([1-9]\d{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.part$/;
const ACTIVE_ARTIFACT_PIN_PATTERN =
    /^\.active-artifact-([1-9]\d{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.pin$/;
const ARTIFACT_OWNER_PATTERN = /^\.artifact-owner-([1-9]\d{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const OWNER_RECORD_MAX_BYTES = 4096;
const PROTECTED_OWNER_CACHE_MS = 1000;
const PROTECTED_OWNER_CACHE_ENTRIES = 64;
// This only avoids redundant native queries. Expiry/eviction never grants cleanup
// authority; the next lookup runs again and PID absence is checked on every use.
const protectedOwnerObservations = new Map();
const ownerSidecarPath = (directory, pid, identity) => join(directory, `.artifact-owner-${pid}-${identity}.json`);
const readOwnerRecord = async (path, fileSystem, legacyEmpty = false) => {
    try {
        const metadata = await fileSystem.lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > OWNER_RECORD_MAX_BYTES) return undefined;
        const contents = await fileSystem.readFile(path, 'utf8');
        if (legacyEmpty && contents === '') return null;
        const record = JSON.parse(contents);
        return record?.version === 1 && Object.hasOwn(record, 'process') ? record : undefined;
    } catch (error) {
        return error?.code === 'ENOENT' ? null : undefined;
    }
};
const createArtifactOwnerObserver = (artifactDir, deadline, isProcessAlive, ownIdentity) => {
    let scope;
    const lookups = new Map();
    return async (pid, recorded) => {
        if (recorded === null || recorded === undefined) return classifyProcessOwner(pid, recorded, { scope: null, selfIdentity: null, isProcessAlive });
        const lookup = () => {
            const key = JSON.stringify([artifactDir, pid, recorded]);
            if (!lookups.has(key)) lookups.set(key, (async () => {
                const now = performance.now();
                for (const [oldKey, entry] of protectedOwnerObservations) {
                    if (entry.until <= now) protectedOwnerObservations.delete(oldKey);
                }
                const cached = protectedOwnerObservations.get(key);
                if (cached) return cached.identity;
                const identity = await readProcessIdentity(pid, deadline - performance.now());
                // Cache matches only, never a dead/replaced verdict or a failed probe.
                // Including the stored birth prevents an old PID sample from condemning a new owner.
                if (identity && hasComparableProcessScope(recorded, identity) && !isDifferentProcess(recorded, identity)) {
                    while (protectedOwnerObservations.size >= PROTECTED_OWNER_CACHE_ENTRIES) {
                        protectedOwnerObservations.delete(protectedOwnerObservations.keys().next().value);
                    }
                    protectedOwnerObservations.set(key, { identity, until: performance.now() + PROTECTED_OWNER_CACHE_MS });
                }
                return identity;
            })());
            return lookups.get(key);
        };
        return classifyProcessOwner(pid, recorded, {
            scope: await (scope ??= Promise.resolve(ownIdentity ?? readCurrentProcessScope())),
            selfIdentity: pid === process.pid ? (ownIdentity ?? await getOwnProcessIdentity()) : undefined,
            lookup, isProcessAlive,
        });
    };
};
const readArtifactOwner = async (artifactDir, match, fileSystem) => {
    const record = await readOwnerRecord(ownerSidecarPath(artifactDir, match[1], match[2]), fileSystem);
    if (record === null) return null;
    if (!record || typeof record.artifactName !== 'string' || basename(record.artifactName) !== record.artifactName ||
        !(record.artifactName === `${match[2]}.xlsx` || record.artifactName.startsWith(`${match[2]}-`) && record.artifactName.endsWith('.xlsx'))) return undefined;
    return record.process;
};
const removeOwnerSidecar = async (artifactDir, match, fileSystem) => {
    const path = ownerSidecarPath(artifactDir, match[1], match[2]);
    await fileSystem.rm(`${path}.pending`, { force: true });
    await fileSystem.rm(path, { force: true });
};
const cleanupOwnerMetadata = async (artifactDir, entries, fileSystem) => {
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const candidate = entry.name.endsWith('.pending') ? entry.name.slice(0, -'.pending'.length) : undefined;
        try {
            // Publication and this cleanup share the same lock. A visible candidate
            // cannot still be published by another active critical section.
            if (candidate && (ARTIFACT_OWNER_PATTERN.test(candidate) || ACTIVE_ARTIFACT_PIN_PATTERN.test(candidate))) {
                await fileSystem.rm(join(artifactDir, entry.name), { force: true });
                continue;
            }
            const match = ARTIFACT_OWNER_PATTERN.exec(entry.name);
            if (!match) continue;
            const pin = `.active-artifact-${match[1]}-${match[2]}.pin`;
            const names = [`.active-${match[1]}-${match[2]}.part`, pin, `${pin}.pending`];
            let associated = false;
            for (const name of names) {
                try { await fileSystem.lstat(join(artifactDir, name)); associated = true; break; }
                catch (error) { if (error?.code !== 'ENOENT') throw error; }
            }
            // No payload is removed here. Without a part or pin there is no
            // remaining protection to describe, even after an ended release fault.
            if (!associated) await fileSystem.rm(join(artifactDir, entry.name), { force: true });
        } catch {
            // Retaining unused metadata cannot make another report unsafe. Leave
            // it for a later sweep; authoritative pins and payloads are checked below.
            console.error('ARTIFACT_OWNER_CLEANUP_PENDING: Owner metadata cleanup remains pending.');
        }
    }
};
const lockOwnerPid = (name) => {
    const match = ARTIFACT_LOCK_OWNER_PATTERN.exec(name);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const defaultIsProcessAlive = (pid) => {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return undefined;
    }
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const defaultScheduleDeferredRelease = (retry, delayMs) => {
    const timer = setTimeout(() => {
        void retry();
    }, delayMs);
    timer.unref();
};
// The lock must live on the same filesystem as the artifacts it guards, so callers that inject a
// `fileSystem` place the lock beside their artifact directory instead of on the real disk.
const acquireArtifactStoreLock = async (artifactDir, fileSystem = defaultFileSystem) => {
    const lockPath = join(artifactDir, '.artifact-store.lock');
    const ownIdentity = await getOwnProcessIdentity();
    const deadline = performance.now() + ARTIFACT_LOCK_RETRY_LIMIT * ARTIFACT_LOCK_RETRY_DELAY_MS;
    const observeOwner = createArtifactOwnerObserver(artifactDir, deadline, defaultIsProcessAlive, ownIdentity);
    for (let attempt = 0; attempt < ARTIFACT_LOCK_RETRY_LIMIT && performance.now() < deadline; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(artifactDir, `.artifact-store-lock-${ownerId}`);
        const candidateOwnerPath = join(candidatePath, ownerId);
        await fileSystem.mkdir(candidatePath, { mode: 0o700 });
        try {
            await fileSystem.writeFile(candidateOwnerPath, JSON.stringify({ version: 1, process: ownIdentity }), { flag: 'wx', mode: 0o600 });
            await fileSystem.rename(candidatePath, lockPath);
            const ownerPath = join(lockPath, ownerId);
            return async () => {
                await fileSystem.rm(ownerPath, { force: true });
                try {
                    await fileSystem.rmdir(lockPath);
                } catch (error) {
                    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
                }
            };
        } catch (error) {
            await fileSystem.rm(candidatePath, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
        }
        try {
            const lockMetadata = await fileSystem.stat(lockPath);
            const ownerEntries = await fileSystem.readdir(lockPath, { withFileTypes: true });
            const ownerStates = await Promise.all(ownerEntries.map(async entry => {
                const pid = entry.isFile() ? lockOwnerPid(entry.name) : null;
                if (pid === null) return null;
                const record = await readOwnerRecord(join(lockPath, entry.name), fileSystem, true);
                return observeOwner(pid, record === null ? null : record?.process);
            }));
            const knownDead = ownerStates.length > 0 && ownerStates.every(state => state === 'dead');
            if (knownDead || Date.now() - lockMetadata.mtimeMs > ARTIFACT_LOCK_STALE_MS) {
                if (ownerStates.some(state => state === 'alive' || state === 'unknown')) {
                    await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
                    continue;
                }
                const currentMetadata = await fileSystem.stat(lockPath);
                if (
                    currentMetadata.dev === lockMetadata.dev &&
                    currentMetadata.ino === lockMetadata.ino &&
                    currentMetadata.mtimeMs === lockMetadata.mtimeMs
                ) {
                    // A successor can appear after stat. Its new marker must survive
                    // cleanup of the names we inspected and block non-recursive removal.
                    for (const entry of ownerEntries) await fileSystem.rm(join(lockPath, entry.name), { recursive: entry.isDirectory(), force: true });
                    try { await fileSystem.rmdir(lockPath); }
                    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY'].includes(error?.code)) throw error; }
                    continue;
                }
            }
        } catch (error) {
            if (!['ENOENT', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
        }
        await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
    }
    throw new ArtifactStoreError('ARTIFACT_STORE_BUSY', 'Artifact storage is busy; retry the export');
};
const ownedLockReleases = createOwnedLockReleaseTracker();
const withArtifactStoreLock = async (artifactDir, operation, fileSystem = defaultFileSystem) => {
    const lockPath = join(artifactDir, '.artifact-store.lock');
    await ownedLockReleases.retryPending(lockPath);
    const release = await acquireArtifactStoreLock(artifactDir, fileSystem);
    let operationError;
    try {
        return await operation();
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {
            await ownedLockReleases.release(lockPath, release);
        } catch (releaseError) {
            if (!operationError) throw releaseError;
        }
    }
};

const removeArtifactPin = async (pinPath, fileSystem) => {
    for (let attempt = 1; attempt <= ARTIFACT_PIN_REMOVE_RETRY_LIMIT; attempt += 1) {
        try {
            await fileSystem.rm(pinPath, { force: true });
            const match = ACTIVE_ARTIFACT_PIN_PATTERN.exec(basename(pinPath));
            if (match) await removeOwnerSidecar(dirname(pinPath), match, fileSystem);
            return;
        } catch (error) {
            if (!TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS.has(error?.code) || attempt === ARTIFACT_PIN_REMOVE_RETRY_LIMIT) throw error;
            await delay(ARTIFACT_LOCK_RETRY_DELAY_MS);
        }
    }
};
const isRetryableArtifactReleaseError = (error) => RETRYABLE_ARTIFACT_RELEASE_ERRORS.has(error?.code);

const scheduleDeferredArtifactRelease = (jobId, usage, scheduleDeferredRelease) => {
    if (usage.releaseRetryScheduled || usage.deferredReleaseAttempts >= ARTIFACT_DEFERRED_RELEASE_RETRY_LIMIT) return;
    usage.releaseRetryScheduled = true;
    try {
        scheduleDeferredRelease(async () => {
            usage.releaseRetryScheduled = false;
            if (jobUsage.get(jobId) !== usage) return;
            usage.deferredReleaseAttempts += 1;
            try {
                await releaseArtifactJob(jobId, { scheduleDeferredRelease });
            } catch {
                // releaseArtifactJob schedules the next bounded retry for transient pin failures.
            }
        }, ARTIFACT_DEFERRED_RELEASE_RETRY_DELAY_MS);
    } catch {
        usage.releaseRetryScheduled = false;
    }
};

const resumeDeferredArtifactRelease = (jobId, usage) => {
    const deferredRelease = usage.deferredRelease;
    if (!deferredRelease || usage.writers > 0 || usage.pendingCleanups > 0 || jobUsage.get(jobId) !== usage) return;
    usage.deferredRelease = undefined;
    void releaseArtifactJob(jobId, { scheduleDeferredRelease: deferredRelease.scheduleDeferredRelease }).catch(() => undefined);
};

export const releaseArtifactJob = async (
    jobId,
    { scheduleDeferredRelease = defaultScheduleDeferredRelease, deferWhileActive = false } = {}
) => {
    const usage = jobUsage.get(jobId);
    if (!usage) return false;
    if (usage.writers > 0 || usage.pendingCleanups > 0) {
        if (deferWhileActive) {
            usage.deferredRelease = { scheduleDeferredRelease };
            return false;
        }
        throw new Error('Cannot release artifact job while active artifact writers or cleanup remain');
    }
    // A terminal release request survives I/O failure. Ordinary locked maintenance
    // can finish its exact pins later without replaying the export or its response.
    usage.deferredRelease = { scheduleDeferredRelease };
    try {
        for (const { artifactDir, fileSystem, pinPaths } of usage.pinGroups.values()) {
            await withArtifactStoreLock(
                artifactDir,
                () => Promise.all([...pinPaths].map((pinPath) => removeArtifactPin(pinPath, fileSystem))),
                fileSystem
            );
        }
    } catch (error) {
        if (isRetryableArtifactReleaseError(error)) {
            scheduleDeferredArtifactRelease(jobId, usage, scheduleDeferredRelease);
        }
        throw error;
    }
    if (jobUsage.get(jobId) === usage) jobUsage.delete(jobId);
    return true;
};

const releaseRequestedArtifactPinsUnlocked = async (artifactDir) => {
    for (const [jobId, usage] of jobUsage) {
        if (!usage.deferredRelease || usage.writers > 0 || usage.pendingCleanups > 0) continue;
        const group = usage.pinGroups.get(artifactDir);
        if (!group) continue;
        // The caller holds this directory's mutex. Only a finished job's explicit
        // release request permits removing its still-live PID's exact pin names.
        try {
            for (const pinPath of group.pinPaths) await removeArtifactPin(pinPath, group.fileSystem);
        } catch {
            // Ordinary pruning still honors any surviving pin. A pin or sidecar
            // deletion fault must not reject an unrelated export with room.
            console.error('ARTIFACT_PIN_RELEASE_PENDING: Requested pin cleanup remains pending.');
            continue;
        }
        if (usage.pinGroups.get(artifactDir) === group) usage.pinGroups.delete(artifactDir);
        if (usage.pinGroups.size === 0 && usage.writers === 0 && usage.pendingCleanups === 0 && jobUsage.get(jobId) === usage) {
            jobUsage.delete(jobId);
        }
    }
};

const pruneArtifactsUnlocked = async ({
    artifactDir = undefined,
    now = Date.now(),
    retentionMs = ARTIFACT_RETENTION_MS,
    maxTotalBytes = ARTIFACT_MAX_TOTAL_BYTES,
    maxFiles = ARTIFACT_MAX_FILES,
    excludePaths = [],
    fileSystem = defaultFileSystem,
    platform = process.platform,
    isProcessAlive = defaultIsProcessAlive,
} = {}) => {
    const errors = [];
    const protectedPaths = new Set(excludePaths);
    const fs = { ...defaultFileSystem, ...fileSystem };
    await ensurePrivateDirectory(artifactDir, fs, platform);
    let entries;
    try {
        await releaseRequestedArtifactPinsUnlocked(artifactDir);
        entries = await fs.readdir(artifactDir, { withFileTypes: true });
    } catch (error) {
        return [asError(error)];
    }

    await cleanupOwnerMetadata(artifactDir, entries, fs);
    const observeOwner = createArtifactOwnerObserver(artifactDir, performance.now() + 2000, isProcessAlive);
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = ACTIVE_ARTIFACT_PIN_PATTERN.exec(entry.name);
        if (!match) continue;
        const pinPath = join(artifactDir, entry.name);
        try {
            if (await observeOwner(Number(match[1]), await readArtifactOwner(artifactDir, match, fs)) === 'dead') {
                await fs.rm(pinPath, { force: true });
                continue;
            }
            await ensurePrivateFile(pinPath, fs, platform);
            const artifactName = await fs.readFile(pinPath, 'utf8');
            if (basename(artifactName) !== artifactName || !artifactName.endsWith('.xlsx')) {
                throw new Error(`Artifact pin ${entry.name} contains an invalid artifact name`);
            }
            protectedPaths.add(join(artifactDir, artifactName));
        } catch (error) {
            errors.push(asError(error));
        }
    }
    if (errors.length > 0) return errors;

    const completed = [];
    let retainedPartBytes = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(artifactDir, entry.name);
        if (entry.name.endsWith('.part')) {
            try {
                const metadata = await fs.stat(path);
                let removed = false;
                if (!protectedPaths.has(path) && !activePartPaths.has(path) && now - metadata.mtimeMs > retentionMs) {
                    const match = ACTIVE_PART_PATTERN.exec(entry.name);
                    if (match && await observeOwner(Number(match[1]), await readArtifactOwner(artifactDir, match, fs)) === 'dead') {
                        await fs.rm(path, { force: true });
                        removed = true;
                    }
                }
                if (!removed) {
                    retainedPartBytes += metadata.size;
                }
            } catch (error) {
                errors.push(asError(error));
            }
            continue;
        }
        if (!entry.name.endsWith('.xlsx')) continue;
        try {
            await ensurePrivateFile(path, fs, platform);
            const metadata = await fs.stat(path);
            if (!protectedPaths.has(path) && now - metadata.mtimeMs > retentionMs) {
                await fs.rm(path, { force: true });
            } else {
                completed.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
            }
        } catch (error) {
            errors.push(asError(error));
        }
    }

    completed.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = retainedPartBytes + completed.reduce((total, artifact) => total + artifact.size, 0);
    let totalFiles = completed.length;
    for (const artifact of completed) {
        if (totalBytes <= maxTotalBytes && totalFiles <= maxFiles) break;
        if (protectedPaths.has(artifact.path)) continue;
        try {
            await fs.rm(artifact.path, { force: true });
            totalBytes -= artifact.size;
            totalFiles -= 1;
        } catch (error) {
            errors.push(asError(error));
        }
    }
    await cleanupOwnerMetadata(artifactDir, entries, fs);
    return errors;
};

export const pruneArtifacts = async (options = {}) => {
    const artifactDir = options.artifactDir ?? requireStorageTarget(options.storageTarget ?? ARTIFACT_STORAGE, 'marketplaceArtifacts');
    const fs = { ...defaultFileSystem, ...(options.fileSystem ?? {}) };
    const platform = options.platform ?? process.platform;
    await ensurePrivateDirectory(artifactDir, fs, platform);
    return withArtifactStoreLock(artifactDir, () => pruneArtifactsUnlocked({ ...options, artifactDir }), fs);
};

export const pruneLegacyArtifacts = async (options = {}) => {
    const artifactDir = options.artifactDir ?? LEGACY_ARTIFACT_DIR;
    const fs = { ...defaultFileSystem, ...(options.fileSystem ?? {}) };
    try {
        // The admission probe and subsequent cleanup must observe the same filesystem adapter.
        const metadata = await fs.lstat(artifactDir);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return [new Error('Legacy artifact directory is invalid')];
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        return [asError(error)];
    }
    return pruneArtifacts({ ...options, artifactDir });
};

const artifactTotalBytes = async (artifactDir, fs) => {
    let totalBytes = 0;
    for (const entry of await fs.readdir(artifactDir, { withFileTypes: true })) {
        if (!entry.isFile() || (!entry.name.endsWith('.xlsx') && !entry.name.endsWith('.part'))) continue;
        totalBytes += (await fs.stat(join(artifactDir, entry.name))).size;
    }
    return totalBytes;
};

const artifactCompletedFileCount = async (artifactDir, fs) =>
    (await fs.readdir(artifactDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.xlsx')).length;

/**
 * @param {{
 *     jobId?: string,
 *     fileName?: string,
 *     mimeType?: string,
 *     artifactDir?: string,
 *     storageTarget?: { state: string, path?: string, reason?: string },
 *     maxChunkBytes?: number,
 *     maxFileBytes?: number,
 *     maxJobBytes?: number,
 *     maxTotalBytes?: number,
 *     maxFiles?: number,
 *     retentionMs?: number,
 *     validateXlsx?: boolean,
 *     signal?: AbortSignal,
 *     scheduleCleanupRetry?: (retry: () => Promise<void>, delayMs: number) => void,
 *     fileSystem?: Partial<typeof defaultFileSystem>,
 *     platform?: NodeJS.Platform,
 * }} options
 */
export const createArtifactWriter = async (options = {}) => {
    const {
        jobId,
        fileName,
        mimeType,
        artifactDir: configuredArtifactDir,
        maxChunkBytes = ARTIFACT_MAX_CHUNK_BYTES,
        maxFileBytes = ARTIFACT_MAX_FILE_BYTES,
        maxJobBytes = ARTIFACT_MAX_JOB_BYTES,
        maxTotalBytes = ARTIFACT_MAX_TOTAL_BYTES,
        maxFiles = ARTIFACT_MAX_FILES,
        retentionMs = ARTIFACT_RETENTION_MS,
        validateXlsx = false,
        signal,
        scheduleCleanupRetry = defaultScheduleDeferredRelease,
        fileSystem = {},
        platform = process.platform,
    } = options;
    const artifactDir = configuredArtifactDir ?? requireStorageTarget(options.storageTarget ?? ARTIFACT_STORAGE, 'marketplaceArtifacts');
    if (typeof jobId !== 'string' || jobId.length === 0) throw new Error('Artifact job ID is required');
    if (typeof mimeType !== 'string' || mimeType.length === 0) throw new Error('Artifact MIME type is required');
    validateLimits({ maxChunkBytes, maxFileBytes, maxJobBytes, maxTotalBytes, maxFiles, retentionMs });
    if (
        signal !== undefined &&
        (typeof signal !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')
    ) {
        throw new TypeError('Artifact writer signal must be an AbortSignal');
    }
    let aborted = false;
    const abortReason = () =>
        signal?.reason instanceof Error ? signal.reason : new Error('Artifact writer is aborted');
    const assertNotAborted = () => {
        if (!aborted && signal?.aborted !== true) return;
        aborted = true;
        throw abortReason();
    };
    assertNotAborted();
    const name = safeArtifactName(fileName);
    const usage = acquireJob(jobId, maxJobBytes);
    const fs = { ...defaultFileSystem, ...fileSystem };
    const identity = randomUUID();
    const partialPath = join(artifactDir, `.active-${process.pid}-${identity}.part`);
    // MSIX adds a package prefix to the real Windows path. Keep that path short
    // for external workbook viewers; the descriptive name remains in metadata.
    const artifactPath = join(artifactDir, platform === 'win32' ? `${identity}.xlsx` : `${identity}-${name}`);
    const pinPath = join(artifactDir, `.active-artifact-${process.pid}-${identity}.pin`);
    const pendingPinPath = `${pinPath}.pending`;
    const ownerPath = ownerSidecarPath(artifactDir, process.pid, identity);
    const pendingOwnerPath = `${ownerPath}.pending`;
    const ownerContents = JSON.stringify({ version: 1, process: await getOwnProcessIdentity(), artifactName: basename(artifactPath) });
    let setupStarted = false;
    try {
        assertNotAborted();
        // Keep the synchronous job reservation, but do not create more file
        // ownership while prior setup cleanup in this directory is blocked.
        await settlePendingSetupCleanups(artifactDir);
        await ensurePrivateDirectory(artifactDir, fs, platform);
        assertNotAborted();
        await withArtifactStoreLock(artifactDir, async () => {
            assertNotAborted();
            await settlePendingSetupCleanups(artifactDir);
            const pruneErrors = await pruneArtifactsUnlocked({ artifactDir, retentionMs, maxTotalBytes, maxFiles, fileSystem: fs, platform });
            assertNotAborted();
            if (pruneErrors.length > 0) throw new Error(`Unable to prune artifact storage: ${pruneErrors[0].message}`);
            assertNotAborted();
            setupStarted = true;
            await fs.writeFile(pendingOwnerPath, ownerContents, { mode: 0o600, flag: 'wx' });
            await fs.rename(pendingOwnerPath, ownerPath);
            assertNotAborted();
            await fs.writeFile(partialPath, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
            assertNotAborted();
            await ensurePrivateFile(partialPath, fs, platform);
            assertNotAborted();
        }, fs);
        assertNotAborted();
    } catch (error) {
        aborted = true;
        if (!setupStarted) {
            // Admission failed before any invocation-owned path could be written.
            usage.writers -= 1;
            resumeDeferredArtifactRelease(jobId, usage);
            throw asError(error);
        }
        // Setup can still own a partial file before a writer object exists. Fast
        // cancellation may already have requested job release, so transfer that
        // ownership to cleanup before removing the writer reservation.
        usage.pendingCleanups += 1;
        usage.writers -= 1;
        let reportedHardFailure = false;
        try {
            // Reuse exact-owner recovery: exhausting a short sharing-violation
            // batch must not abandon this partial or the job's release request.
            await pendingSetupCleanups.release(artifactDir, async () => {
                try {
                    await fs.rm(partialPath, { force: true });
                    await fs.rm(pendingOwnerPath, { force: true });
                    await fs.rm(ownerPath, { force: true });
                }
                catch (cleanupError) {
                    // Also runs if a later background attempt reaches a permanent
                    // failure. The tracker must not hide that safe diagnostic.
                    if (!TRANSIENT_ARTIFACT_PIN_REMOVE_ERRORS.has(cleanupError?.code) && !reportedHardFailure) {
                        reportedHardFailure = true;
                        console.error('ARTIFACT_CLEANUP_FAILED: Artifact writer setup cleanup remains pending.');
                    }
                    throw cleanupError;
                }
                usage.pendingCleanups -= 1;
                resumeDeferredArtifactRelease(jobId, usage);
            });
        } catch (cleanupError) {
            throw new AggregateError([asError(error), asError(cleanupError)], 'Artifact writer setup failed and cleanup failed');
        }
        throw asError(error);
    }
    activePartPaths.add(partialPath);

    /** @type {Promise<unknown>} */
    let writeChain = Promise.resolve();
    let nextIndex = 0;
    let byteCount = 0;
    let usageByteCount = 0;
    const hash = createHash('sha256');
    let completed = false;
    let writerClosed = false;
    let usageBytesDiscarded = false;
    let pinRegistered = false;
    let cleanupTracked = false;
    let cleanupCompleted = false;
    let payloadMayExist = false;
    let pinMayExist = false;
    let cleanupPromise;
    let abortCleanupPromise;
    let cleanupRetryAttempts = 0;
    let cleanupRetryScheduled = false;
    const discardUsageBytes = () => {
        if (usageBytesDiscarded) return;
        usage.bytes -= usageByteCount;
        usageBytesDiscarded = true;
    };
    const closeWriter = ({ discardBytes }) => {
        if (discardBytes) discardUsageBytes();
        if (!writerClosed) {
            usage.writers -= 1;
            writerClosed = true;
        }
    };
    const registerPin = () => {
        let pinGroup = usage.pinGroups.get(artifactDir);
        if (!pinGroup) {
            pinGroup = { artifactDir, fileSystem: fs, pinPaths: new Set() };
            usage.pinGroups.set(artifactDir, pinGroup);
        }
        pinGroup.pinPaths.add(pinPath);
        pinRegistered = true;
    };
    const unregisterPin = () => {
        if (!pinRegistered) return;
        const pinGroup = usage.pinGroups.get(artifactDir);
        pinGroup?.pinPaths.delete(pinPath);
        if (pinGroup?.pinPaths.size === 0) usage.pinGroups.delete(artifactDir);
        pinRegistered = false;
    };
    const beginCleanup = () => {
        if (cleanupTracked) return;
        cleanupTracked = true;
        usage.pendingCleanups += 1;
    };
    const finishCleanup = () => {
        cleanupCompleted = true;
        if (!cleanupTracked) return;
        cleanupTracked = false;
        usage.pendingCleanups -= 1;
        resumeDeferredArtifactRelease(jobId, usage);
    };
    const scheduleCleanupRetryAfter = (error) => {
        if (
            cleanupRetryScheduled ||
            cleanupRetryAttempts >= ARTIFACT_CLEANUP_RETRY_LIMIT ||
            !isRetryableArtifactReleaseError(error)
        ) {
            return;
        }
        cleanupRetryScheduled = true;
        try {
            scheduleCleanupRetry(async () => {
                cleanupRetryScheduled = false;
                cleanupRetryAttempts += 1;
                try {
                    await cleanupPaths();
                } catch {
                    // cleanupPaths retains ownership and schedules the next bounded retry when appropriate.
                }
            }, ARTIFACT_CLEANUP_RETRY_DELAY_MS);
        } catch {
            cleanupRetryScheduled = false;
        }
    };
    const cleanupPaths = () => {
        if (cleanupPromise) return cleanupPromise;
        const attempt = (async () => {
            let pathsRemoved = false;
            try {
                await withArtifactStoreLock(artifactDir, async () => {
                    await fs.rm(partialPath, { force: true });
                    activePartPaths.delete(partialPath);
                    await fs.rm(artifactPath, { force: true });
                    payloadMayExist = false;
                    await fs.rm(pendingPinPath, { force: true });
                    await fs.rm(pinPath, { force: true });
                    pinMayExist = false;
                    await fs.rm(pendingOwnerPath, { force: true });
                    await fs.rm(ownerPath, { force: true });
                    pathsRemoved = true;
                }, fs);
            } finally {
                // File cleanup has completed even if releasing the mutex fails.
                // Its exact-owner tracker retains the lock; retaining this writer's
                // ledger as well would strand it after that separate lock recovers.
                if (pathsRemoved) {
                    unregisterPin();
                    finishCleanup();
                }
            }
        })();
        const observedAttempt = attempt.catch((error) => {
            if (cleanupPromise === observedAttempt) cleanupPromise = undefined;
            if (!payloadMayExist && !pinMayExist && !pinRegistered) finishCleanup();
            scheduleCleanupRetryAfter(error);
            throw error;
        });
        cleanupPromise = observedAttempt;
        return cleanupPromise;
    };
    const abortInternal = async () => {
        aborted = true;
        if (cleanupCompleted) return;
        beginCleanup();
        closeWriter({ discardBytes: true });
        await cleanupPaths();
    };
    const fail = async (error) => {
        const primaryError = asError(error);
        try {
            await abortInternal();
        } catch (cleanupError) {
            const aggregate = new AggregateError([primaryError, asError(cleanupError)], 'Artifact storage failed and cleanup failed');
            if (primaryError instanceof ArtifactStoreError) Object.assign(aggregate, { code: primaryError.code });
            throw aggregate;
        }
        throw primaryError;
    };
    const assertWritable = () => {
        assertNotAborted();
        if (completed) throw new Error('Artifact writer is already complete');
    };
    const requestAbort = () => {
        if (completed && signal === undefined) return writeChain.then(() => undefined);
        aborted = true;
        if (abortCleanupPromise) return abortCleanupPromise;
        if (cleanupCompleted) return Promise.resolve();
        beginCleanup();
        const pendingWrites = writeChain;
        abortCleanupPromise = pendingWrites.then(
            async () => {
                closeWriter({ discardBytes: true });
                await cleanupPaths();
            },
            async () => {
                closeWriter({ discardBytes: true });
                await cleanupPaths();
            }
        );
        writeChain = abortCleanupPromise;
        return abortCleanupPromise;
    };
    if (signal) {
        signal.addEventListener(
            'abort',
            () => {
                void requestAbort().catch(() => undefined);
            },
            { once: true }
        );
        if (signal.aborted) void requestAbort().catch(() => undefined);
    }

    return {
        appendChunk(index, base64Data) {
            writeChain = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(index) || index !== nextIndex) throw new Error(`Unexpected artifact chunk index: expected ${nextIndex}`);
                    const bytes = decodeCanonicalBase64(base64Data, maxChunkBytes);
                    if (bytes.length > maxChunkBytes) throw new Error(`Artifact chunk exceeds the ${maxChunkBytes}-byte chunk limit`);
                    if (byteCount + bytes.length > maxFileBytes) throw new Error(`Artifact exceeds the ${maxFileBytes}-byte per-file limit`);
                    if (usage.bytes + bytes.length > usage.maxJobBytes) {
                        throw new ArtifactStoreError(
                            'JOB_ARTIFACT_QUOTA_EXCEEDED',
                            `Artifact job quota exceeds the ${usage.maxJobBytes}-byte limit`
                        );
                    }
                    assertNotAborted();
                    await withArtifactStoreLock(artifactDir, async () => {
                        assertNotAborted();
                        // Measured fresh under the lock on every chunk. Carrying a per-writer running total
                        // instead would let a concurrent process's writes go unseen, so this writer could
                        // keep appending past the shared quota by as much as its own remaining file.
                        let totalBytes = await artifactTotalBytes(artifactDir, fs);
                        assertNotAborted();
                        if (totalBytes + bytes.length > maxTotalBytes) {
                            assertNotAborted();
                            await pruneArtifactsUnlocked({
                                artifactDir,
                                retentionMs,
                                maxTotalBytes: maxTotalBytes - bytes.length,
                                maxFiles,
                                excludePaths: [partialPath, artifactPath],
                                fileSystem: fs,
                                platform,
                            });
                            assertNotAborted();
                            totalBytes = await artifactTotalBytes(artifactDir, fs);
                            assertNotAborted();
                        }
                        if (totalBytes + bytes.length > maxTotalBytes) {
                            throw new ArtifactStoreError(
                                'ARTIFACT_TOTAL_QUOTA_EXCEEDED',
                                `Artifact storage quota exceeds the ${maxTotalBytes}-byte limit`
                            );
                        }
                        usage.bytes += bytes.length;
                        usageByteCount += bytes.length;
                        try {
                            assertNotAborted();
                            await fs.appendFile(partialPath, bytes);
                            assertNotAborted();
                        } catch (error) {
                            usage.bytes -= bytes.length;
                            usageByteCount -= bytes.length;
                            throw error;
                        }
                    }, fs);
                    assertNotAborted();
                    byteCount += bytes.length;
                    hash.update(bytes);
                    nextIndex += 1;
                } catch (error) {
                    await fail(error);
                }
            });
            return writeChain;
        },
        /** @param {{ size?: number, sha256?: string }} completion */
        complete(completion = {}) {
            const { size, sha256 } = completion;
            writeChain = writeChain.then(async () => {
                try {
                    assertWritable();
                    if (!Number.isSafeInteger(size) || size < 0 || size !== byteCount) throw new Error('Artifact declared size does not match written bytes');
                    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Artifact SHA-256 must be a lowercase hexadecimal digest');
                    if (hash.digest('hex') !== sha256) throw new Error('Artifact SHA-256 does not match written bytes');
                    assertNotAborted();
                    if (validateXlsx) {
                        assertNotAborted();
                        const workbook = await fs.readFile(partialPath);
                        assertNotAborted();
                        assertXlsxPackage(workbook, { maxFileBytes });
                        assertNotAborted();
                    }
                    assertNotAborted();
                    await withArtifactStoreLock(artifactDir, async () => {
                        assertNotAborted();
                        payloadMayExist = true;
                        await fs.rename(partialPath, artifactPath);
                        assertNotAborted();
                        activePartPaths.delete(partialPath);
                        assertNotAborted();
                        await ensurePrivateFile(artifactPath, fs, platform);
                        assertNotAborted();
                        pinMayExist = true;
                        await fs.writeFile(pendingPinPath, basename(artifactPath), { mode: 0o600, flag: 'wx' });
                        await fs.rename(pendingPinPath, pinPath);
                        assertNotAborted();
                        await ensurePrivateFile(pinPath, fs, platform);
                        assertNotAborted();
                        const pruneErrorsAfterPublish = await pruneArtifactsUnlocked({
                            artifactDir,
                            retentionMs,
                            maxTotalBytes,
                            maxFiles,
                            excludePaths: [artifactPath],
                            fileSystem: fs,
                            platform,
                        });
                        assertNotAborted();
                        if (pruneErrorsAfterPublish.length > 0) throw new Error(`Unable to prune artifact storage: ${pruneErrorsAfterPublish[0].message}`);
                        assertNotAborted();
                        const completedFileCount = await artifactCompletedFileCount(artifactDir, fs);
                        assertNotAborted();
                        if (completedFileCount > maxFiles) {
                            throw new ArtifactStoreError(
                                'ARTIFACT_FILE_QUOTA_EXCEEDED',
                                `Artifact storage quota exceeds the ${maxFiles}-file limit`,
                                { retryable: true }
                            );
                        }
                    }, fs);
                    assertNotAborted();
                    // The logical AppData path can exist only in the producer's
                    // MSIX view. External Excel needs the finalized physical path;
                    // pins and cleanup still own the original logical path.
                    const deliveredPath = platform === 'win32' ? await fs.realpath(artifactPath) : artifactPath;
                    assertNotAborted();
                    const artifact = { name, path: deliveredPath, uri: pathToFileURL(deliveredPath).href, mimeType, size: byteCount, sha256 };
                    assertNotAborted();
                    registerPin();
                    assertNotAborted();
                    completed = true;
                    closeWriter({ discardBytes: false });
                    resumeDeferredArtifactRelease(jobId, usage);
                    return artifact;
                } catch (error) {
                    await fail(error);
                }
            });
            return writeChain;
        },
        abort() {
            return requestAbort();
        },
    };
};
