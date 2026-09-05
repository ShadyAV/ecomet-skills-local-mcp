import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    FEEDBACK_ARTIFACT_STORAGE,
    FEEDBACK_ARTIFACT_MAX_FILES,
    FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
    FEEDBACK_ARTIFACT_RETENTION_MS,
    FEEDBACK_KINDS,
    FEEDBACK_MAX_BYTES,
    LEGACY_FEEDBACK_ARTIFACT_DIR,
} from './config.mjs';
import { FeedbackPreparationError } from './feedback-errors.mjs';
import { requireStorageTarget } from './storage-layout.mjs';

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FEEDBACK_KIND_SET = new Set(FEEDBACK_KINDS);
const FEEDBACK_STORE_LOCK_RETRY_LIMIT = 200;
const FEEDBACK_STORE_LOCK_RETRY_DELAY_MS = 25;
const FEEDBACK_STORE_LOCK_ROLLBACK_RETRY_LIMIT = 3;
const FEEDBACK_STORE_LOCK_STALE_MS = 30_000;
const FEEDBACK_STORE_LOCK_OWNER_PATTERN = /^([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FEEDBACK_STORE_LOCK_CANDIDATE_PATTERN = /^\.feedback-artifact-store-lock-([1-9]\d{0,9})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PENDING_ARTIFACT_PATTERN = /^\.pending-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const PENDING_MANIFEST_PATTERN = /^\.pending-manifest-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const FEEDBACK_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

class FeedbackReconciliationError extends Error {
    constructor(cause) {
        super('Feedback artifact cleanup reconciliation is incomplete', { cause });
        this.feedbackReason = 'storage_cleanup_incomplete';
    }
}
const storageError = (message, reason) => Object.assign(new Error(message), { feedbackReason: reason });

// Registration keeps filesystem diagnostics private; the preparation boundary maps them to this stable public outcome.
export const feedbackArtifactStorageUnavailable = (cause) => new FeedbackPreparationError('FEEDBACK_STORAGE_UNAVAILABLE', cause);

const assertPositiveInteger = (value, name) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Feedback ${name} must be a positive safe integer`);
};
// Inputs are capped at FEEDBACK_MAX_BYTES before this native digest; the bounded synchronous work avoids
// adding a streaming lifecycle while the store lock protects one immutable snapshot.
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asNodeError = (error) => (error instanceof Error ? error : new Error(String(error)));
const isNotFound = (error) => error?.code === 'ENOENT';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const lockOwnerPid = (name) => {
    const match = FEEDBACK_STORE_LOCK_OWNER_PATTERN.exec(name);
    const pid = match ? Number(match[1]) : Number.NaN;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const isProcessAlive = (pid) => {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'ESRCH' ? false : undefined;
    }
};

const sameDirectoryIdentity = (first, second) => first.dev === second.dev && first.ino === second.ino;

const rollbackEmptyFeedbackStoreLock = async (lockPath) => {
    let ownedIdentity;
    for (let attempt = 0; attempt < FEEDBACK_STORE_LOCK_ROLLBACK_RETRY_LIMIT; attempt += 1) {
        let current;
        try {
            current = await stat(lockPath);
        } catch (error) {
            if (isNotFound(error)) return;
            throw error;
        }
        if (ownedIdentity === undefined) ownedIdentity = current;
        else if (!sameDirectoryIdentity(ownedIdentity, current)) return;
        try {
            await rmdir(lockPath);
            return;
        } catch (error) {
            if (isNotFound(error)) return;
            if (!['EPERM', 'EBUSY'].includes(error?.code) || attempt + 1 === FEEDBACK_STORE_LOCK_ROLLBACK_RETRY_LIMIT) throw error;
            await delay(FEEDBACK_STORE_LOCK_RETRY_DELAY_MS);
        }
    }
};

const hasLiveFeedbackStoreCandidate = async (artifactDirectory) => {
    const entries = await readdir(artifactDirectory, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = FEEDBACK_STORE_LOCK_CANDIDATE_PATTERN.exec(entry.name);
        if (match === null) continue;
        const pid = Number(match[1]);
        if (isProcessAlive(pid) === false) continue;
        const ownerId = entry.name.slice('.feedback-artifact-store-lock-'.length);
        try {
            const owners = await readdir(join(artifactDirectory, entry.name), { withFileTypes: true });
            if (owners.some((owner) => owner.isFile() && owner.name === ownerId)) return true;
        } catch (error) {
            if (!isNotFound(error)) return true;
        }
    }
    return false;
};

const reclaimDeadFeedbackStoreCandidates = async (artifactDirectory) => {
    const entries = await readdir(artifactDirectory, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = FEEDBACK_STORE_LOCK_CANDIDATE_PATTERN.exec(entry.name);
        if (match === null) continue;
        const pid = Number(match[1]);
        if (isProcessAlive(pid) !== false) continue;
        const candidatePath = join(artifactDirectory, entry.name);
        let metadata;
        try {
            metadata = await stat(candidatePath);
            if (!metadata.isDirectory() || isProcessAlive(pid) !== false) continue;
            const current = await stat(candidatePath);
            if (current.dev !== metadata.dev || current.ino !== metadata.ino || current.mtimeMs !== metadata.mtimeMs) continue;
            const stalePath = join(artifactDirectory, `.feedback-artifact-store-stale-lock-${process.pid}-${randomUUID()}`);
            await rename(candidatePath, stalePath);
            await rm(stalePath, { recursive: true, force: true }).catch(() => {});
        } catch {
            // Dead-intent cleanup is best-effort housekeeping. Ignore every lookup or rename
            // failure here; the subsequent lock acquisition remains authoritative.
        }
    }
};

const ensurePrivateDirectory = async (directory, platform) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Feedback artifact directory must be a private real directory');
    if (platform !== 'win32') await chmod(directory, 0o700);
};

const ensurePrivateFile = async (path, platform) => {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Feedback artifact file must be a regular non-symlink file');
    if (platform !== 'win32') await chmod(path, 0o600);
};

const assertBytes = (value, name, maximum, { allowEmpty = false } = {}) => {
    if (!Buffer.isBuffer(value)) throw new TypeError(`Feedback ${name} bytes must be a Buffer`);
    if (!allowEmpty && value.length === 0) throw new RangeError(`Feedback ${name} bytes must not be empty`);
    if (value.length > maximum) throw new RangeError(`Feedback ${name} exceeds the ${maximum}-byte limit`);
};

const artifactPath = (artifactDirectory, artifactId) => join(artifactDirectory, artifactId);
const manifestPath = (artifactDirectory) => join(artifactDirectory, 'manifest.json');
const emptyManifest = () => ({ schemaVersion: MANIFEST_SCHEMA_VERSION, artifacts: [], pendingCleanup: [] });

const validManifestEntry = (entry) =>
    entry &&
    typeof entry === 'object' &&
    Object.keys(entry).length === 6 &&
    ARTIFACT_ID_PATTERN.test(entry.artifactId) &&
    FEEDBACK_KIND_SET.has(entry.kind) &&
    Number.isSafeInteger(entry.sizeBytes) &&
    entry.sizeBytes > 0 &&
    SHA256_PATTERN.test(entry.sha256) &&
    typeof entry.transcriptIncluded === 'boolean' &&
    Number.isSafeInteger(entry.createdAtMs) &&
    entry.createdAtMs >= 0;

const readManifest = async (artifactDirectory) => {
    const path = manifestPath(artifactDirectory);
    let bytes;
    try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES) {
            throw new Error('Feedback artifact manifest is invalid');
        }
        bytes = await readFile(path);
    } catch (error) {
        if (isNotFound(error)) return emptyManifest();
        throw asNodeError(error);
    }
    let manifest;
    try {
        manifest = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('Feedback artifact manifest is invalid');
    }
    if (
        !manifest ||
        typeof manifest !== 'object' ||
        Array.isArray(manifest)
    ) {
        throw new Error('Feedback artifact manifest is invalid');
    }
    const hasLegacyShape = Object.keys(manifest).length === 2 && Object.hasOwn(manifest, 'schemaVersion') && Object.hasOwn(manifest, 'artifacts');
    if (
        (!hasLegacyShape && Object.keys(manifest).length !== 3) ||
        manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
        !Array.isArray(manifest.artifacts) ||
        manifest.artifacts.length > FEEDBACK_ARTIFACT_MAX_FILES ||
        !manifest.artifacts.every(validManifestEntry) ||
        (manifest.pendingCleanup !== undefined && (!Array.isArray(manifest.pendingCleanup) || manifest.pendingCleanup.length > FEEDBACK_ARTIFACT_MAX_FILES || !manifest.pendingCleanup.every(validManifestEntry)))
    ) {
        throw new Error('Feedback artifact manifest is invalid');
    }
    const pendingCleanup = manifest.pendingCleanup ?? [];
    if (manifest.artifacts.length + pendingCleanup.length > FEEDBACK_ARTIFACT_MAX_FILES) {
        throw new Error('Feedback artifact manifest is invalid');
    }
    const allIds = [...manifest.artifacts, ...pendingCleanup].map((entry) => entry.artifactId);
    if (new Set(allIds).size !== allIds.length) throw new Error('Feedback artifact manifest is invalid');
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, artifacts: manifest.artifacts, pendingCleanup };
};

const existingFeedbackDirectory = async (directory, artifactId) => {
    if (typeof directory !== 'string') return false;
    try {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
        const manifest = await readManifest(directory);
        return [...manifest.artifacts, ...manifest.pendingCleanup].some((entry) => entry.artifactId === artifactId);
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
    }
};

const realDirectoryExists = async (directory) => {
    if (typeof directory !== 'string') return false;
    try {
        const metadata = await lstat(directory);
        return metadata.isDirectory() && !metadata.isSymbolicLink();
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
    }
};

const locateFeedbackDirectory = async ({ artifactId, configuredDirectory, storageTarget, legacyArtifactDirectory }) => {
    if (configuredDirectory !== undefined) {
        return (await existingFeedbackDirectory(configuredDirectory, artifactId)) ? configuredDirectory : undefined;
    }
    const candidates = new Set([
        ...(storageTarget?.state === 'ready' ? [storageTarget.path] : []),
        ...(typeof legacyArtifactDirectory === 'string' ? [legacyArtifactDirectory] : []),
    ]);
    const matches = [];
    for (const directory of candidates) {
        if (await existingFeedbackDirectory(directory, artifactId)) matches.push(directory);
    }
    if (matches.length > 1) {
        throw storageError('Feedback artifact identity is ambiguous across storage generations', 'artifact_ambiguous');
    }
    return matches[0];
};

const writeManifest = async (artifactDirectory, manifest, platform) => {
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    if (bytes.length > MAX_MANIFEST_BYTES) throw new RangeError('Feedback artifact manifest exceeds its byte limit');
    const temporaryPath = join(artifactDirectory, `.pending-manifest-${randomUUID()}`);
    await writeFile(temporaryPath, bytes, { mode: 0o600, flag: 'wx' });
    try {
        await ensurePrivateFile(temporaryPath, platform);
        await rename(temporaryPath, manifestPath(artifactDirectory));
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
};

const acquireFeedbackStoreLock = async (artifactDirectory) => {
    const lockPath = join(artifactDirectory, '.feedback-artifact-store.lock');
    await reclaimDeadFeedbackStoreCandidates(artifactDirectory);
    for (let attempt = 0; attempt < FEEDBACK_STORE_LOCK_RETRY_LIMIT; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(artifactDirectory, `.feedback-artifact-store-lock-${ownerId}`);
        const candidateOwnerPath = join(candidatePath, ownerId);
        const ownerPath = join(lockPath, ownerId);
        let acquired = false;
        let published = false;
        await mkdir(candidatePath, { mode: 0o700 });
        try {
            await writeFile(candidateOwnerPath, '', { mode: 0o600, flag: 'wx' });
            // The final mkdir is the portable atomic claim. The populated candidate remains a
            // live intent until its owner marker moves into the lock, protecting a delayed
            // publisher while an old empty lock remains reclaimable after the stale grace.
            await mkdir(lockPath, { mode: 0o700 });
            acquired = true;
            await rename(candidateOwnerPath, ownerPath);
            published = true;
        } catch (error) {
            let rollbackError;
            if (acquired) {
                try {
                    // The populated candidate keeps conforming waiters from replacing our empty lock;
                    // identity rechecks keep a retry from removing an unexpected successor.
                    await rollbackEmptyFeedbackStoreLock(lockPath);
                } catch (cleanupError) {
                    rollbackError = cleanupError;
                }
            }
            let candidateCleanupError;
            try {
                await rm(candidatePath, { recursive: true, force: true });
            } catch (cleanupError) {
                candidateCleanupError = cleanupError;
            }
            if (rollbackError) throw rollbackError;
            if (candidateCleanupError) throw candidateCleanupError;
            // A stale reclaimer may remove our not-yet-published empty lock. That is contention,
            // not a terminal filesystem failure; the populated candidate is discarded and retried.
            if (!['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
        }
        if (published) {
            // Publication transferred the only owner marker into the final lock. Empty candidate removal
            // is housekeeping and cannot revoke an otherwise valid acquisition.
            await rmdir(candidatePath).catch(() => undefined);
            return async () => {
                await rm(join(lockPath, ownerId), { force: true });
                try {
                    await rmdir(lockPath);
                } catch (error) {
                    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
                }
            };
        }
        try {
            const metadata = await stat(lockPath);
            // Read populated intents before final owners: publication moves the marker between them,
            // so either side of the transition is observed while empty cleanup residue is ignored.
            const liveCandidate = await hasLiveFeedbackStoreCandidate(artifactDirectory);
            const lockEntries = await readdir(lockPath, { withFileTypes: true });
            const owners = lockEntries
                .filter((entry) => entry.isFile())
                .map((entry) => lockOwnerPid(entry.name))
                .filter((pid) => pid !== null);
            // This is deliberately conservative, not fair: any observed live/unknown publisher wins
            // protection, so overlapping publishers may make a waiter exhaust its bounded retries.
            // Identifiable dead owners need no age grace. Live/unknown processes remain protected.
            if (!liveCandidate && !owners.some((pid) => isProcessAlive(pid) !== false) &&
                (owners.length > 0 || Date.now() - metadata.mtimeMs > FEEDBACK_STORE_LOCK_STALE_MS)) {
                const current = await stat(lockPath);
                if (current.dev === metadata.dev && current.ino === metadata.ino && current.mtimeMs === metadata.mtimeMs) {
                    // WHY: a pathname rename could move a live successor installed after the stat above.
                    // Remove only names observed in the stale directory; a successor's fresh owner marker
                    // then makes this non-recursive rmdir fail safely instead of deleting its critical section.
                    for (const entry of lockEntries) {
                        await rm(join(lockPath, entry.name), { recursive: entry.isDirectory(), force: true });
                    }
                    try {
                        await rmdir(lockPath);
                    } catch (error) {
                        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY'].includes(error?.code)) throw error;
                    }
                    continue;
                }
            }
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        await delay(FEEDBACK_STORE_LOCK_RETRY_DELAY_MS);
    }
    throw storageError('Feedback artifact storage is busy', 'storage_busy');
};

const withFeedbackStoreLock = async (artifactDirectory, operation) => {
    const release = await acquireFeedbackStoreLock(artifactDirectory);
    let operationError;
    try {
        return await operation();
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {
            await release();
        } catch (releaseError) {
            if (!operationError) throw releaseError;
        }
    }
};

const reportResource = (artifactDirectory, artifactId) => ({
    uri: pathToFileURL(join(artifactPath(artifactDirectory, artifactId), 'report.md')).href,
    name: 'report.md',
    mimeType: 'text/markdown',
});

const pruneEntries = (entries, { maxArtifacts, maxTotalBytes, retentionMs, nowMs, physicalBytes }) => {
    const ordered = [...entries].sort((left, right) => left.createdAtMs - right.createdAtMs || left.artifactId.localeCompare(right.artifactId));
    const expired = ordered.filter((entry) => nowMs - entry.createdAtMs > retentionMs);
    const retained = ordered.filter((entry) => !expired.includes(entry));
    let total = totalEntryBytes(retained, physicalBytes);
    const removed = [...expired];
    while (retained.length > maxArtifacts || total > maxTotalBytes) {
        const entry = retained.shift();
        if (!entry) break;
        total -= physicalBytes.get(entry.artifactId);
        removed.push(entry);
    }
    return { retained, removed };
};

const totalEntryBytes = (entries, physicalBytes) => entries.reduce((sum, entry) => sum + physicalBytes.get(entry.artifactId), 0);

const measureArtifactBytes = async (artifactDirectory, entries) => {
    // Keep metadata reads serialized under the store lock: the manifest is hard-bounded to 100
    // entries, and avoiding filesystem fan-out is preferable until profiling proves this scan
    // approaches the lock deadline on supported hosts.
    const physicalBytes = new Map();
    for (const entry of entries) {
        let total = 0;
        for (const name of ['report.md', 'feedback.zip']) {
            try {
                total += (await lstat(join(artifactPath(artifactDirectory, entry.artifactId), name))).size;
            } catch (error) {
                if (!isNotFound(error)) throw new FeedbackReconciliationError(error);
            }
        }
        physicalBytes.set(entry.artifactId, total);
    }
    return physicalBytes;
};

const retryPendingCleanup = async (artifactDirectory, entries, removeArtifactImpl) => {
    const remaining = [];
    for (const entry of entries) {
        try {
            await removeArtifactImpl(artifactPath(artifactDirectory, entry.artifactId), { recursive: true, force: true });
        } catch {
            remaining.push(entry);
        }
    }
    return remaining;
};

const manifestEquals = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const removeCrashLeftovers = async (artifactDirectory, manifest, removeArtifactImpl) => {
    const indexed = new Set([...manifest.artifacts, ...manifest.pendingCleanup].map((entry) => entry.artifactId));
    const entries = await readdir(artifactDirectory, { withFileTypes: true });
    let cleanupError;
    for (const entry of entries) {
        const isPending = PENDING_ARTIFACT_PATTERN.test(entry.name) || PENDING_MANIFEST_PATTERN.test(entry.name);
        const isUnindexedArtifact = ARTIFACT_ID_PATTERN.test(entry.name) && !indexed.has(entry.name);
        if (!isPending && !isUnindexedArtifact) continue;
        try {
            await removeArtifactImpl(join(artifactDirectory, entry.name), { recursive: true, force: true });
        } catch (error) {
            cleanupError ??= new FeedbackReconciliationError(error);
        }
    }
    // WHY: unindexed crash survivors have no trustworthy manifest accounting. Reconciliation must fail closed
    // before pruning or admission rather than silently exceeding the physical count or byte quota.
    if (cleanupError) throw cleanupError;
};

const retainExistingArtifactDirectories = async (artifactDirectory, entries, removeArtifactImpl) => {
    const retained = [];
    for (const entry of entries) {
        const path = artifactPath(artifactDirectory, entry.artifactId);
        try {
            const metadata = await lstat(path);
            if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
                retained.push(entry);
            } else {
                await removeArtifactImpl(path, { recursive: true, force: true }).catch(() => undefined);
            }
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
    }
    return retained;
};

const reconcileStoreUnlocked = async ({
    artifactDirectory,
    manifest,
    maxArtifacts,
    maxTotalBytes,
    retentionMs,
    nowMs,
    platform,
    writeManifestImpl,
    removeArtifactImpl,
}) => {
    const pendingCleanup = await retryPendingCleanup(artifactDirectory, manifest.pendingCleanup, removeArtifactImpl);
    const withPendingRetried = { ...manifest, pendingCleanup };
    await removeCrashLeftovers(artifactDirectory, withPendingRetried, removeArtifactImpl);
    const existing = await retainExistingArtifactDirectories(artifactDirectory, manifest.artifacts, removeArtifactImpl);
    // WHY: sizeBytes is the upload's ZIP size, not disk usage. Measuring both stored files also accounts
    // for legacy manifests and reports left behind by a partially successful directory removal.
    const physicalBytes = await measureArtifactBytes(artifactDirectory, [...existing, ...pendingCleanup]);
    const pendingCleanupBytes = totalEntryBytes(pendingCleanup, physicalBytes);
    // WHY: registration passes candidate-reserved limits here. If surviving tombstones alone exceed either
    // limit, admission is impossible and must fail before pruning otherwise-valid active artifacts.
    if (pendingCleanup.length > maxArtifacts) {
        throw storageError('Feedback artifact directory capacity is exhausted by pending cleanup', 'storage_capacity');
    }
    if (pendingCleanupBytes > maxTotalBytes) {
        throw storageError('Feedback artifact byte capacity is exhausted by pending cleanup', 'storage_capacity');
    }
    const { retained, removed } = pruneEntries(existing, {
        maxArtifacts: Math.max(0, maxArtifacts - pendingCleanup.length),
        maxTotalBytes: Math.max(0, maxTotalBytes - pendingCleanupBytes),
        retentionMs,
        nowMs,
        physicalBytes,
    });
    const nextPendingCleanup = [...pendingCleanup, ...removed];
    if (retained.length + nextPendingCleanup.length > FEEDBACK_ARTIFACT_MAX_FILES) {
        throw storageError('Feedback artifact cleanup backlog is full', 'storage_capacity');
    }
    const tombstonedManifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        artifacts: retained,
        pendingCleanup: nextPendingCleanup,
    };
    if (!manifestEquals(manifest, tombstonedManifest)) {
        await writeManifestImpl(artifactDirectory, tombstonedManifest, platform);
    }
    const failedRemoved = await retryPendingCleanup(artifactDirectory, removed, removeArtifactImpl);
    const nextManifest = {
        ...tombstonedManifest,
        pendingCleanup: [...pendingCleanup, ...failedRemoved],
    };
    if (!manifestEquals(tombstonedManifest, nextManifest)) {
        await writeManifestImpl(artifactDirectory, nextManifest, platform);
    }
    if (nextManifest.artifacts.length + nextManifest.pendingCleanup.length > maxArtifacts) {
        throw storageError('Feedback artifact directory capacity is exhausted by pending cleanup', 'storage_capacity');
    }
    if (totalEntryBytes([...nextManifest.artifacts, ...nextManifest.pendingCleanup], physicalBytes) > maxTotalBytes) {
        throw storageError('Feedback artifact byte capacity is exhausted by pending cleanup', 'storage_capacity');
    }
    return nextManifest;
};

/**
 * @param {{ kind: string, includeTranscript: boolean, reportBytes: Buffer, archiveBytes: Buffer }} artifact
 * @param {{ artifactDirectory?: string, storageTarget?: { state: string, path?: string, reason?: string }, maxArtifacts?: number, maxTotalBytes?: number, retentionMs?: number, now?: () => number, platform?: NodeJS.Platform, writeManifestImpl?: typeof writeManifest, removeArtifactImpl?: typeof rm, createArtifactId?: () => string }} options
 */
export const registerFeedbackArtifact = async (artifact, options = {}) => {
    const {
        artifactDirectory: configuredArtifactDirectory,
        maxArtifacts = FEEDBACK_ARTIFACT_MAX_FILES,
        maxTotalBytes = FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        now = Date.now,
        platform = process.platform,
        writeManifestImpl = writeManifest,
        removeArtifactImpl = rm,
        createArtifactId = randomUUID,
    } = options;
    const artifactDirectory = configuredArtifactDirectory ?? requireStorageTarget(
        options.storageTarget ?? FEEDBACK_ARTIFACT_STORAGE,
        'feedbackArtifacts'
    );
    if (!artifact || typeof artifact !== 'object' || !FEEDBACK_KIND_SET.has(artifact.kind)) throw new RangeError('Feedback kind is invalid');
    if (typeof artifact.includeTranscript !== 'boolean') throw new TypeError('Feedback transcript inclusion must be a boolean');
    assertBytes(artifact.reportBytes, 'report', FEEDBACK_MAX_BYTES);
    assertBytes(artifact.archiveBytes, 'archive', FEEDBACK_MAX_BYTES);
    assertPositiveInteger(maxArtifacts, 'artifact count limit');
    assertPositiveInteger(maxTotalBytes, 'artifact total byte limit');
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof writeManifestImpl !== 'function') throw new TypeError('Feedback manifest writer must be a function');
    if (typeof removeArtifactImpl !== 'function') throw new TypeError('Feedback artifact remover must be a function');
    if (typeof createArtifactId !== 'function') throw new TypeError('Feedback artifact ID factory must be a function');
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    const candidateBytes = artifact.reportBytes.length + artifact.archiveBytes.length;
    if (candidateBytes > maxTotalBytes) throw new RangeError(`Feedback artifact exceeds the ${maxTotalBytes}-byte storage limit`);

    await ensurePrivateDirectory(artifactDirectory, platform);
    return withFeedbackStoreLock(artifactDirectory, async () => {
        const initialManifest = await readManifest(artifactDirectory);
        const artifactId = createArtifactId();
        if (
            !ARTIFACT_ID_PATTERN.test(artifactId) ||
            [...initialManifest.artifacts, ...initialManifest.pendingCleanup].some((entry) => entry.artifactId === artifactId)
        ) {
            throw new Error('Feedback artifact ID is invalid');
        }
        const manifest = await reconcileStoreUnlocked({
            artifactDirectory,
            manifest: initialManifest,
            // Reserve the candidate's physical directory slot and bytes before any candidate files exist.
            maxArtifacts: maxArtifacts - 1,
            maxTotalBytes: maxTotalBytes - candidateBytes,
            retentionMs,
            nowMs,
            platform,
            writeManifestImpl,
            removeArtifactImpl,
        });
        const pendingPath = join(artifactDirectory, `.pending-${artifactId}`);
        const finalPath = artifactPath(artifactDirectory, artifactId);
        await mkdir(pendingPath, { mode: 0o700 });
        try {
            await ensurePrivateDirectory(pendingPath, platform);
            const reportPath = join(pendingPath, 'report.md');
            const archivePath = join(pendingPath, 'feedback.zip');
            await writeFile(reportPath, artifact.reportBytes, { mode: 0o600, flag: 'wx' });
            await writeFile(archivePath, artifact.archiveBytes, { mode: 0o600, flag: 'wx' });
            await ensurePrivateFile(reportPath, platform);
            await ensurePrivateFile(archivePath, platform);
            await rename(pendingPath, finalPath);
        } catch (error) {
            await rm(pendingPath, { recursive: true, force: true }).catch(() => undefined);
            throw asNodeError(error);
        }

        const entry = {
            artifactId,
            kind: artifact.kind,
            sizeBytes: artifact.archiveBytes.length,
            sha256: sha256(artifact.archiveBytes),
            transcriptIncluded: artifact.includeTranscript,
            createdAtMs: nowMs,
        };
        const nextManifest = {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            artifacts: [...manifest.artifacts, entry],
            pendingCleanup: manifest.pendingCleanup,
        };
        try {
            await writeManifestImpl(artifactDirectory, nextManifest, platform);
        } catch (error) {
            await rm(finalPath, { recursive: true, force: true }).catch(() => undefined);
            throw asNodeError(error);
        }
        const committed = await readManifest(artifactDirectory);
        const committedEntry = committed.artifacts.find((candidate) => candidate.artifactId === artifactId);
        if (!committedEntry || !manifestEquals(committedEntry, entry)) {
            // Commit status is uncertain. Leave the candidate for the next locked reconciliation rather than
            // deleting a directory that a committed manifest may already reference.
            throw new Error('Feedback artifact was not committed');
        }
        return { ...entry, reportResource: reportResource(artifactDirectory, artifactId) };
    });
};

/**
 * @param {{ artifactId: string, expectedSize: number, expectedSha256: string }} request
 * @param {{ artifactDirectory?: string, legacyArtifactDirectory?: string, storageTarget?: { state: string, path?: string, reason?: string }, platform?: NodeJS.Platform, retentionMs?: number, now?: () => number, writeManifestImpl?: typeof writeManifest, removeArtifactImpl?: typeof rm }} options
 */
export const loadVerifiedFeedbackArtifact = async (request, options = {}) => {
    const {
        artifactDirectory: configuredArtifactDirectory,
        platform = process.platform,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        now = Date.now,
        writeManifestImpl = writeManifest,
        removeArtifactImpl = rm,
    } = options;
    const storageTarget = options.storageTarget ?? FEEDBACK_ARTIFACT_STORAGE;
    if (!request || typeof request !== 'object' || !ARTIFACT_ID_PATTERN.test(request.artifactId)) throw new RangeError('Feedback artifact ID is invalid');
    assertPositiveInteger(request.expectedSize, 'expected size');
    if (typeof request.expectedSha256 !== 'string' || !SHA256_PATTERN.test(request.expectedSha256)) {
        throw new RangeError('Feedback expected SHA-256 is invalid');
    }
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof now !== 'function' || typeof writeManifestImpl !== 'function' || typeof removeArtifactImpl !== 'function') {
        throw new TypeError('Feedback artifact load dependencies are invalid');
    }
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    const artifactDirectory = await locateFeedbackDirectory({
        artifactId: request.artifactId,
        configuredDirectory: configuredArtifactDirectory,
        storageTarget,
        legacyArtifactDirectory: options.legacyArtifactDirectory ?? LEGACY_FEEDBACK_ARTIFACT_DIR,
    });
    if (artifactDirectory === undefined) {
        if (configuredArtifactDirectory === undefined && storageTarget.state !== 'ready') {
            requireStorageTarget(storageTarget, 'feedbackArtifacts');
        }
        throw storageError('Feedback artifact is missing or expired', 'artifact_missing');
    }
    return withFeedbackStoreLock(artifactDirectory, async () => {
        const originalManifest = await readManifest(artifactDirectory);
        let manifest;
        try {
            manifest = await reconcileStoreUnlocked({
                artifactDirectory,
                manifest: originalManifest,
                maxArtifacts: FEEDBACK_ARTIFACT_MAX_FILES,
                maxTotalBytes: FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
                retentionMs,
                nowMs,
                platform,
                writeManifestImpl,
                removeArtifactImpl,
            });
        } catch (error) {
            // WHY: whole-store reconciliation grants no admission here. If its pre-prune scan is
            // temporarily blocked, the exact indexed target still has to pass every check below.
            if (!(error instanceof FeedbackReconciliationError)) throw error;
            manifest = originalManifest;
        }
        const entry = manifest.artifacts.find((candidate) => candidate.artifactId === request.artifactId);
        if (!entry) throw storageError('Feedback artifact is missing or expired', 'artifact_missing');
        if (nowMs - entry.createdAtMs > retentionMs) throw storageError('Feedback artifact is expired', 'artifact_expired');
        if (request.expectedSize !== entry.sizeBytes) throw new Error('Feedback expected size does not match the artifact');
        if (request.expectedSha256 !== entry.sha256) throw new Error('Feedback expected SHA-256 does not match the artifact');

        const directory = artifactPath(artifactDirectory, entry.artifactId);
        const directoryMetadata = await lstat(directory).catch((error) => {
            if (isNotFound(error)) throw new Error('Feedback artifact is missing');
            throw error;
        });
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error('Feedback artifact directory is invalid');
        const archivePath = join(directory, 'feedback.zip');
        const archiveMetadata = await lstat(archivePath).catch((error) => {
            if (isNotFound(error)) throw new Error('Feedback archive is missing');
            throw error;
        });
        if (archiveMetadata.isSymbolicLink()) throw new Error('Feedback archive symlink is rejected');
        if (!archiveMetadata.isFile()) throw new Error('Feedback archive is invalid');
        const size = (await stat(archivePath)).size;
        if (size <= 0 || size > FEEDBACK_MAX_BYTES) throw new Error('Feedback archive is invalid');
        const bytes = await readFile(archivePath);
        const actualSha256 = sha256(bytes);
        if (bytes.length !== entry.sizeBytes || bytes.length !== request.expectedSize || actualSha256 !== entry.sha256 || actualSha256 !== request.expectedSha256) {
            throw storageError('Feedback archive integrity verification failed', 'artifact_integrity');
        }
        return { bytes, kind: entry.kind, sizeBytes: entry.sizeBytes, sha256: entry.sha256, transcriptIncluded: entry.transcriptIncluded };
    });
};

/**
 * Removes one definitively uploaded artifact. The manifest first moves the entry into pendingCleanup so any
 * filesystem failure remains durable and ordinary maintenance can retry it.
 * @param {{ artifactId: string }} request
 * @param {{ artifactDirectory?: string, legacyArtifactDirectory?: string, storageTarget?: { state: string, path?: string, reason?: string }, maxArtifacts?: number, platform?: NodeJS.Platform, retentionMs?: number, now?: () => number, writeManifestImpl?: typeof writeManifest, removeArtifactImpl?: typeof rm }} options
 */
export const retireFeedbackArtifact = async (request, options = {}) => {
    const {
        artifactDirectory: configuredArtifactDirectory,
        maxArtifacts = FEEDBACK_ARTIFACT_MAX_FILES,
        platform = process.platform,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        now = Date.now,
        writeManifestImpl = writeManifest,
        removeArtifactImpl = rm,
    } = options;
    const storageTarget = options.storageTarget ?? FEEDBACK_ARTIFACT_STORAGE;
    if (!request || typeof request !== 'object' || !ARTIFACT_ID_PATTERN.test(request.artifactId)) {
        throw new RangeError('Feedback artifact ID is invalid');
    }
    assertPositiveInteger(maxArtifacts, 'artifact count limit');
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof now !== 'function' || typeof writeManifestImpl !== 'function' || typeof removeArtifactImpl !== 'function') {
        throw new TypeError('Feedback artifact retirement dependencies are invalid');
    }
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    const artifactDirectory = await locateFeedbackDirectory({
        artifactId: request.artifactId,
        configuredDirectory: configuredArtifactDirectory,
        storageTarget,
        legacyArtifactDirectory: options.legacyArtifactDirectory ?? LEGACY_FEEDBACK_ARTIFACT_DIR,
    });
    if (artifactDirectory === undefined) return { retired: false, localCleanup: 'complete' };
    return withFeedbackStoreLock(artifactDirectory, async () => {
        const manifest = await reconcileStoreUnlocked({
            artifactDirectory,
            manifest: await readManifest(artifactDirectory),
            maxArtifacts,
            maxTotalBytes: FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
            retentionMs,
            nowMs,
            platform,
            writeManifestImpl,
            removeArtifactImpl,
        });
        const entry = manifest.artifacts.find((candidate) => candidate.artifactId === request.artifactId);
        if (!entry) {
            const pending = manifest.pendingCleanup.some((candidate) => candidate.artifactId === request.artifactId);
            let physical = false;
            try {
                await lstat(artifactPath(artifactDirectory, request.artifactId));
                physical = true;
            } catch (error) {
                if (!isNotFound(error)) throw error;
            }
            // WHY: reconciliation may have tombstoned the target before retirement acquired the lock. A
            // non-throwing no-op is complete only when neither the manifest nor disk still retains the target.
            return { retired: false, localCleanup: pending || physical ? 'pending' : 'complete' };
        }
        const pendingCleanup = [...manifest.pendingCleanup, entry];
        const tombstoned = {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            artifacts: manifest.artifacts.filter((candidate) => candidate.artifactId !== entry.artifactId),
            pendingCleanup,
        };
        if (tombstoned.artifacts.length + tombstoned.pendingCleanup.length > maxArtifacts) {
            throw storageError('Feedback artifact cleanup backlog is full', 'storage_capacity');
        }
        // WHY: publish and verify the tombstone before deleting either report.md or feedback.zip. A failed
        // directory removal then remains discoverable across process death and is retried by maintenance.
        await writeManifestImpl(artifactDirectory, tombstoned, platform);
        const committed = await readManifest(artifactDirectory);
        const committedTombstone = committed.pendingCleanup.find((candidate) => candidate.artifactId === entry.artifactId);
        if (
            committed.artifacts.some((candidate) => candidate.artifactId === entry.artifactId) ||
            !committedTombstone ||
            !manifestEquals(committedTombstone, entry)
        ) {
            throw new Error('Feedback artifact retirement was not committed');
        }
        await removeArtifactImpl(artifactPath(artifactDirectory, entry.artifactId), { recursive: true, force: true });
        const retired = {
            ...committed,
            pendingCleanup: committed.pendingCleanup.filter((candidate) => candidate.artifactId !== entry.artifactId),
        };
        await writeManifestImpl(artifactDirectory, retired, platform);
        const committedRetirement = await readManifest(artifactDirectory);
        const indexed = [...committedRetirement.artifacts, ...committedRetirement.pendingCleanup]
            .some((candidate) => candidate.artifactId === entry.artifactId);
        return { retired: !indexed, localCleanup: indexed ? 'pending' : 'complete' };
    });
};

/**
 * Reconciles crash leftovers and applies retention/quota limits without preparing a new artifact.
 * @param {{ artifactDirectory?: string, legacyArtifactDirectory?: string, storageTarget?: { state: string, path?: string, reason?: string }, maxArtifacts?: number, maxTotalBytes?: number, retentionMs?: number, now?: () => number, platform?: NodeJS.Platform, writeManifestImpl?: typeof writeManifest, removeArtifactImpl?: typeof rm }} options
 */
export const maintainFeedbackArtifacts = async (options = {}) => {
    const {
        artifactDirectory: configuredArtifactDirectory,
        maxArtifacts = FEEDBACK_ARTIFACT_MAX_FILES,
        maxTotalBytes = FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        now = Date.now,
        platform = process.platform,
        writeManifestImpl = writeManifest,
        removeArtifactImpl = rm,
    } = options;
    const storageTarget = options.storageTarget ?? FEEDBACK_ARTIFACT_STORAGE;
    if (configuredArtifactDirectory === undefined) {
        const candidates = [
            ...(storageTarget.state === 'ready' ? [storageTarget.path] : []),
            options.legacyArtifactDirectory ?? LEGACY_FEEDBACK_ARTIFACT_DIR,
        ];
        const existing = [];
        for (const directory of new Set(candidates)) {
            if (await realDirectoryExists(directory)) existing.push(directory);
        }
        for (const artifactDirectory of existing) {
            await maintainFeedbackArtifacts({ ...options, artifactDirectory });
        }
        return;
    }
    const artifactDirectory = configuredArtifactDirectory;
    assertPositiveInteger(maxArtifacts, 'artifact count limit');
    assertPositiveInteger(maxTotalBytes, 'artifact total byte limit');
    assertPositiveInteger(retentionMs, 'artifact retention');
    if (typeof now !== 'function' || typeof writeManifestImpl !== 'function' || typeof removeArtifactImpl !== 'function') {
        throw new TypeError('Feedback artifact maintenance dependencies are invalid');
    }
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Feedback artifact clock must return a non-negative safe integer');
    await ensurePrivateDirectory(artifactDirectory, platform);
    await withFeedbackStoreLock(artifactDirectory, async () => {
        await reconcileStoreUnlocked({
            artifactDirectory,
            manifest: await readManifest(artifactDirectory),
            maxArtifacts,
            maxTotalBytes,
            retentionMs,
            nowMs,
            platform,
            writeManifestImpl,
            removeArtifactImpl,
        });
    });
};

/**
 * Starts one immediate and then non-overlapping periodic maintenance loop.
 * @param {{ intervalMs?: number, maintain?: () => Promise<void>, setIntervalImpl?: typeof setInterval, clearIntervalImpl?: typeof clearInterval, onError?: (error: Error) => void }} options
 */
export const startFeedbackArtifactMaintenance = (options = {}) => {
    const {
        intervalMs = FEEDBACK_MAINTENANCE_INTERVAL_MS,
        maintain = maintainFeedbackArtifacts,
        setIntervalImpl = setInterval,
        clearIntervalImpl = clearInterval,
        onError = () => undefined,
    } = options;
    if (
        !Number.isSafeInteger(intervalMs) ||
        intervalMs < 1 ||
        intervalMs > FEEDBACK_ARTIFACT_RETENTION_MS ||
        typeof maintain !== 'function' ||
        typeof setIntervalImpl !== 'function' ||
        typeof clearIntervalImpl !== 'function' ||
        typeof onError !== 'function'
    ) {
        throw new TypeError('Feedback artifact maintenance scheduler is invalid');
    }
    let running;
    let stopped = false;
    const run = () => {
        if (stopped) return Promise.resolve();
        if (running) return running;
        running = Promise.resolve()
            .then(() => maintain())
            .catch((error) => onError(asNodeError(error)))
            .finally(() => {
                running = undefined;
            });
        return running;
    };
    const ready = run();
    const timer = setIntervalImpl(run, intervalMs);
    timer?.unref?.();
    return {
        ready,
        stop: () => {
            if (stopped) return;
            stopped = true;
            clearIntervalImpl(timer);
        },
    };
};
