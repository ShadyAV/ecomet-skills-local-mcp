import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MAX_MCP_MESSAGE_BYTES, FEEDBACK_ARTIFACT_RETENTION_MS, FEEDBACK_MAX_BYTES } from '../mcp/src/config.mjs';
import { getOwnProcessIdentity, classifyProcessOwner, readCurrentProcessScope } from '../mcp/src/process-identity.mjs';
import { toolOutputSchemas, validateSchemaValue } from '../mcp/src/tool-schemas.mjs';
import { feedbackHostAdapterMarkerSchema } from '../mcp/src/feedback-host-adapter.mjs';
import { feedbackDiagnostics } from '../mcp/src/feedback-diagnostics.mjs';
import { withStoreLock } from './feedback-handoff.mjs';

const METADATA_BYTES = 64 * 1024;
const MAX_ENTRIES = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = reason => Object.assign(new Error('The private cloud feedback state is unavailable.'), { feedbackReason: reason });
const invalid = () => failure('invalid_state');
const missingState = error => error?.code === 'ENOENT'
    ? Object.assign(failure('state_missing'), { code: 'ENOENT', cause: error }) : error;
const encoded = value => JSON.stringify(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validOperationInput = op => (op.inputHash === undefined || HASH.test(op.inputHash))
    && (op.input === undefined ? HASH.test(op.inputHash)
        : record(op.input) && record(op.input.authored)
            && (op.input.transcriptPath === undefined || typeof op.input.transcriptPath === 'string'));
const validOperationResult = (binding, result) => {
    const schema = toolOutputSchemas[binding?.toolName?.split('__').at(-1)];
    return Boolean(schema && validateSchemaValue(result, schema));
};
export const bindingKey = binding => hash(encoded([binding.sessionId, binding.toolName, binding.callId]));

export const cloudPaths = env => {
    const root = env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA;
    if (typeof root !== 'string' || !root.trim()) throw failure('storage_unavailable');
    const base = resolve(root);
    return { root: join(base, 'feedback-cloud-v1'), handoff: join(base, 'feedback-cloud-v1', 'handoff'),
        claims: join(base, 'feedback-cloud-v1', 'claims'), artifacts: join(base, 'feedback-cloud-v1', 'artifacts') };
};

const syncDirectory = async path => {
    // Windows does not expose directory fsync through Node. The supported cloud
    // host is Linux; Windows tests additionally exercise private path isolation.
    if (process.platform === 'win32') return;
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
};
const privateDirectory = async (path, create = false) => {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalid();
    if (process.platform !== 'win32') await chmod(path, 0o700);
};

const readRecord = async (path, max = METADATA_BYTES, optional = false) => {
    let handle;
    try {
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink() || before.size > max) throw invalid();
        handle = await open(path, 'r');
        const after = await handle.stat();
        if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size > max) throw invalid();
        let bytes = Buffer.alloc(Math.min(METADATA_BYTES, after.size + 1));
        const chunks = [];
        let total = 0;
        let filled = 0;
        for (;;) {
            // A short read is not EOF. Probe at most one byte past the bound so
            // growth after stat cannot turn this into an unbounded read.
            const { bytesRead } = await handle.read(bytes, filled, Math.min(bytes.length - filled, max + 1 - total), total);
            if (!bytesRead) { chunks.push(bytes.subarray(0, filled)); break; }
            total += bytesRead;
            if (total > max) throw invalid();
            filled += bytesRead;
            if (filled === bytes.length) {
                chunks.push(bytes);
                bytes = Buffer.alloc(Math.min(METADATA_BYTES, max + 1 - total));
                filled = 0;
            }
        }
        return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } catch (error) {
        if (optional && error?.code === 'ENOENT') return undefined;
        if (error instanceof SyntaxError) throw Object.assign(invalid(), { cause: error });
        throw error;
    } finally { await handle?.close(); }
};
const writeExclusive = async (path, value, max = METADATA_BYTES) => {
    const bytes = Buffer.from(encoded(value));
    if (bytes.length > max) throw failure('storage_capacity');
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
};
const replaceRecord = async (path, name, value) => {
    // Callers hold the store lock. A crash/short write must never expose a
    // partial canonical receipt or replace a replayable operation with one.
    // One fixed candidate per record bounds interrupted cleanup. Under the lock
    // a predecessor's candidate is never executable and may be replaced safely.
    const temporary = join(path, `.${name}.json`);
    await rm(temporary, { force: true });
    try {
        await writeExclusive(temporary, value);
        await rename(temporary, join(path, `${name}.json`));
        await syncDirectory(path);
    } finally {
        await rm(temporary, { force: true });
    }
};
// Only these names prove initialization never became executable. Every caller
// holds the store lock; publication is the single rename to the canonical key.
const initializing = name => name.startsWith('.initializing-') && UUID.test(name.slice(14));
const removeEmpty = async path => {
    await privateDirectory(path);
    try { await rmdir(path); return true; }
    catch (error) { if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) return false; throw error; }
};
const cleanupInitializing = async root => {
    for (const name of await readdir(root)) {
        if (!initializing(name)) continue;
        const path = join(root, name);
        await privateDirectory(path);
        await rm(path, { recursive: true });
    }
};
const publishDirectory = async (path, initialize, { syncDirectoryImpl = syncDirectory, onPublished = () => {} } = {}) => {
    // rename may replace an empty destination on POSIX. Preserve exclusive keys.
    try { await lstat(path); throw Object.assign(invalid(), { code: 'EEXIST' }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const root = dirname(path);
    const temporary = join(root, `.initializing-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
        await initialize(temporary);
        await syncDirectoryImpl(temporary);
        await rename(temporary, path);
        onPublished();
        // Do not remove the canonical guard if publication fsync fails.
        await syncDirectoryImpl(root);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
};
const owner = async () => ({ pid: process.pid, identity: await getOwnProcessIdentity() });
const dead = async record => record && await classifyProcessOwner(record.pid, record.identity, {
    scope: await readCurrentProcessScope(), selfIdentity: await getOwnProcessIdentity(),
}) === 'dead';
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const validIntent = intent => intent?.version === 1 && HASH.test(intent.sessionHash)
    && UUID.test(intent.artifactId) && UUID.test(intent.attemptId) && HASH.test(intent.sha256)
    && validTime(intent.createdAtMs) && Number.isSafeInteger(intent.sizeBytes) && intent.sizeBytes > 0
    && intent.sizeBytes <= FEEDBACK_MAX_BYTES && typeof intent.transcriptIncluded === 'boolean';
const validTerminal = (terminal, intent) => terminal?.version === 1 && terminal.attemptId === intent.attemptId
    && terminal.artifactId === intent.artifactId && validTime(terminal.recordedAtMs)
    && ['uploaded', 'rejected', 'uncertain', 'not_started'].includes(terminal.result?.status)
    && terminal.result.artifactId === intent.artifactId
    && validateSchemaValue(terminal.result, toolOutputSchemas.submit_e_comet_feedback)
    && (terminal.result.status !== 'uploaded' || terminal.result.transcriptIncluded === intent.transcriptIncluded);

// Operations retain at most one MCP-sized authored payload per pending entry
// (128 MiB worst case). Completed entries keep only bounded safe outcomes.
// Attempts have independent 128 slots, each reserving 64 KiB for its terminal
// record BEFORE intent/PUT. ZIP bytes continue using canonical archive quotas.
export class CloudFeedbackStore {
    constructor(paths, { now = Date.now, fileNow = Date.now, retireArtifact, maxEntries = MAX_ENTRIES, beforePublishTerminal, syncDirectoryImpl = syncDirectory, syncPublicationDirectoryImpl = syncDirectory } = {}) {
        Object.assign(this, { paths, now, fileNow, retireArtifact, maxEntries, beforePublishTerminal, syncDirectoryImpl, syncPublicationDirectoryImpl });
    }
    async initialize(create = false) {
        try {
            await privateDirectory(this.paths.root, create);
            await privateDirectory(join(this.paths.root, 'operations'), create);
            await privateDirectory(join(this.paths.root, 'attempts'), create);
            if (create) await syncDirectory(this.paths.root);
        } catch (error) {
            // Absent state is distinct from an observed filesystem fault, but
            // does not prove this artifact was never uploaded under a lost root.
            throw create ? error : missingState(error);
        }
    }
    operationPath(binding) { return join(this.paths.root, 'operations', bindingKey(binding)); }
    attemptPath(sessionId, artifactId) {
        if (!UUID.test(artifactId)) throw invalid();
        return join(this.paths.root, 'attempts', hash(encoded([hash(sessionId), artifactId])));
    }
    async locked(action) { return withStoreLock(this.paths.root, this.fileNow, action); }
    async cleanupOperations() {
        const root = join(this.paths.root, 'operations');
        await cleanupInitializing(root);
        for (const name of await readdir(root)) {
            if (!HASH.test(name)) continue;
            const path = join(root, name);
            try {
                if (await removeEmpty(path)) continue;
                const op = await readRecord(join(path, 'operation.json'), MAX_MCP_MESSAGE_BYTES + METADATA_BYTES);
                if (!validTime(op.createdAtMs)) continue;
                if (this.now() - op.createdAtMs <= FEEDBACK_ARTIFACT_RETENTION_MS) {
                    if (op.input && op.binding && bindingKey(op.binding) === name) {
                        const result = await readRecord(join(path, 'result.json'), METADATA_BYTES, true);
                        if (validOperationResult(op.binding, result)) {
                            await syncDirectory(path);
                            await this.compactOperationUnlocked(op.binding);
                        }
                    }
                    continue;
                }
                const running = await readRecord(join(path, 'owner.json'), METADATA_BYTES, true);
                const result = await readRecord(join(path, 'result.json'), METADATA_BYTES, true);
                if (running && !result && !await dead(running)) continue;
                await rm(path, { recursive: true });
            } catch { /* Unknown state cannot free an admission slot. */ }
        }
    }
    async stage(binding, input, originalAuthored = input.authored) {
        await this.initialize(true);
        return this.locked(async () => {
            await this.cleanupOperations();
            if ((await readdir(join(this.paths.root, 'operations'))).length >= this.maxEntries) throw failure('storage_capacity');
            const path = this.operationPath(binding);
            const marker = { version: 1, operationId: randomUUID(), nonce: randomBytes(32).toString('base64url') };
            const operation = { version: 1, binding, marker, input, originalInputHash: hash(encoded(originalAuthored)), createdAtMs: this.now() };
            await publishDirectory(path, temporary => writeExclusive(join(temporary, 'operation.json'), operation, MAX_MCP_MESSAGE_BYTES + METADATA_BYTES),
                { syncDirectoryImpl: this.syncPublicationDirectoryImpl });
            return marker;
        });
    }
    async readOperation(binding) {
        await this.initialize();
        const op = await readRecord(join(this.operationPath(binding), 'operation.json'), MAX_MCP_MESSAGE_BYTES + METADATA_BYTES)
            .catch(error => { throw missingState(error); });
        if (op?.version !== 1 || encoded(op.binding) !== encoded(binding) || !validTime(op.createdAtMs)
            || !validateSchemaValue(op.marker, feedbackHostAdapterMarkerSchema)
            || (op.originalInputHash !== undefined && !HASH.test(op.originalInputHash))
            || !validOperationInput(op)
            || op.createdAtMs > this.now() + 5000 || this.now() - op.createdAtMs > FEEDBACK_ARTIFACT_RETENTION_MS) throw invalid();
        return op;
    }
    async claimOperation(binding) {
        return this.locked(async () => {
            const path = this.operationPath(binding);
            const result = await readRecord(join(path, 'result.json'), METADATA_BYTES, true);
            if (result) {
                if (!validOperationResult(binding, result)) throw invalid();
                // A previous owner may have died between rename and directory
                // sync. Establish receipt durability before exposing replay.
                await syncDirectory(path);
                // Private-field cleanup is ancillary: retry it on replay without
                // downgrading a durable result when cleanup still cannot finish.
                await this.compactOperationUnlocked(binding).catch(() => undefined);
                return { result };
            }
            try { await writeExclusive(join(path, 'owner.json'), await owner()); }
            catch (error) { if (error?.code === 'EEXIST') return { running: true }; throw error; }
            await syncDirectory(path);
            return { owned: true };
        });
    }
    async finishOperation(binding, result) {
        // Callers supply canonical internal tool results; diagnostics are bounded
        // by the same allowlists used in the output schema. Replay validates the
        // persisted record because filesystem contents are a separate trust boundary.
        return this.locked(async () => {
            const path = this.operationPath(binding);
            // Preserve exclusive result publication, including unreadable legacy
            // receipts. A partial old receipt never authorizes overwriting it.
            try { await lstat(join(path, 'result.json')); throw Object.assign(invalid(), { code: 'EEXIST' }); }
            catch (error) { if (error?.code !== 'ENOENT') throw error; }
            await replaceRecord(path, 'result', result);
            await this.compactOperationUnlocked(binding);
        });
    }
    async compactOperationUnlocked(binding) {
        // Drop private report/history fields after durable result publication. Keep
        // a digest to validate duplicate Post input without retaining report text.
        const op = await this.readOperation(binding);
        if (op.input === undefined) return;
        const completed = { ...op, inputHash: hash(encoded(op.input.authored)) };
        delete completed.input;
        await replaceRecord(this.operationPath(binding), 'operation', completed);
    }
    inputMatches(op, input) {
        // Accept only the exact original or exact fitted representation. Refitting
        // Post input would hide mutations within omitted/redacted report text.
        if (!validOperationInput(op)) throw invalid();
        const digest = hash(encoded(input));
        return digest === op.originalInputHash || digest === (op.inputHash ?? hash(encoded(op.input.authored)));
    }
    async readArtifactOutcome(sessionId, artifactId) {
        await this.initialize();
        return this.locked(async () => {
            const outcome = await this.readArtifactOutcomeUnlocked(sessionId, artifactId);
            // A predecessor may have died after rename but before directory
            // fsync. Establish publication durability while excluding writers
            // before any caller can report success or retire the archive.
            if (outcome?.terminal) await syncDirectory(this.attemptPath(sessionId, artifactId));
            return outcome;
        });
    }
    async readArtifactOutcomeUnlocked(sessionId, artifactId) {
        const path = this.attemptPath(sessionId, artifactId);
        let metadata;
        try { metadata = await lstat(path); }
        catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalid();
        // Legacy mkdir-before-write failures are reclaimable only when empty.
        // Any bytes, including a partial reserve or intent, remain ambiguous.
        if (await removeEmpty(path)) return undefined;
        const intent = await readRecord(join(path, 'intent.json'));
        if (!validIntent(intent) || intent.sessionHash !== hash(sessionId) || intent.artifactId !== artifactId) throw invalid();
        const terminal = await readRecord(join(path, 'terminal.json'), METADATA_BYTES, true);
        if (terminal) {
            if (!validTerminal(terminal, intent)) throw invalid();
            return { ...intent, terminal: true, result: terminal.result };
        }
        return { ...intent, result: { ok: false, status: 'uncertain', artifactId,
            error: { code: 'UPLOAD_UNCERTAIN', message: 'An upload intent exists without a confirmed outcome. Do not send this artifact again.', stage: 'upload', retryable: false } } };
    }
    async cleanupAttempts(currentBinding) {
        await cleanupInitializing(join(this.paths.root, 'attempts'));
        // An expired attempt cannot be discarded while ANY unfinished operation
        // may hold verified bytes/a grant. Retire canonically before releasing its
        // guard: the attempt time plus artifact retention is a conservative bound.
        for (const name of await readdir(join(this.paths.root, 'operations'))) {
            // The caller has just established that its own artifact has no guard.
            // Its verified bytes cannot belong to one of these expired attempts.
            if (currentBinding && name === bindingKey(currentBinding)) continue;
            if (initializing(name)) continue;
            if (!HASH.test(name)) return;
            const path = join(this.paths.root, 'operations', name);
            const active = await readRecord(join(path, 'owner.json'), METADATA_BYTES, true);
            if (active && !await readRecord(join(path, 'result.json'), METADATA_BYTES, true) && !await dead(active)) return;
        }
        for (const name of await readdir(join(this.paths.root, 'attempts'))) {
            if (!HASH.test(name)) continue;
            const path = join(this.paths.root, 'attempts', name);
            try {
                if (await removeEmpty(path)) continue;
                const intent = await readRecord(join(path, 'intent.json'));
                if (!validIntent(intent) || name !== hash(encoded([intent.sessionHash, intent.artifactId]))
                    || this.now() - intent.createdAtMs <= FEEDBACK_ARTIFACT_RETENTION_MS || !this.retireArtifact) continue;
                const terminal = await readRecord(join(path, 'terminal.json'), METADATA_BYTES, true);
                if (terminal ? !validTerminal(terminal, intent) : !await dead(intent.owner)) continue;
                const retired = await this.retireArtifact({ artifactId: intent.artifactId });
                if (retired?.localCleanup !== 'complete') continue;
                await rm(path, { recursive: true });
                await syncDirectory(join(this.paths.root, 'attempts'));
            } catch { /* Preserve guard on unknown state or unsuccessful retirement. */ }
        }
    }
    async beginUploadAttempt(sessionId, metadata, currentBinding) {
        return this.locked(async () => {
            const previous = await this.readArtifactOutcomeUnlocked(sessionId, metadata.artifactId);
            if (previous) {
                // Only a durable, exact-owner no-request terminal releases the
                // artifact for fresh authorization. Unknown/partial intents and
                // possibly-started attempts never take this branch.
                if (!previous.terminal || previous.result.status !== 'not_started'
                    || previous.sha256 !== metadata.sha256 || previous.sizeBytes !== metadata.sizeBytes
                    || previous.transcriptIncluded !== metadata.transcriptIncluded) throw failure('upload_already_started');
                await rm(this.attemptPath(sessionId, metadata.artifactId), { recursive: true });
                await syncDirectory(join(this.paths.root, 'attempts'));
            }
            await this.cleanupAttempts(currentBinding);
            if ((await readdir(join(this.paths.root, 'attempts'))).length >= this.maxEntries) throw failure('storage_capacity');
            const path = this.attemptPath(sessionId, metadata.artifactId);
            const intent = { version: 1, sessionHash: hash(sessionId), ...metadata, attemptId: randomUUID(), createdAtMs: this.now(), owner: await owner() };
            let published = false;
            try {
                await publishDirectory(path, async temporary => {
                    // Allocate actual bytes before publishing intent/allowing PUT.
                    const reserved = await open(join(temporary, 'terminal-reserve'), 'wx', 0o600);
                    try { await reserved.writeFile(Buffer.alloc(METADATA_BYTES)); await reserved.sync(); } finally { await reserved.close(); }
                    await writeExclusive(join(temporary, 'intent.json'), intent);
                }, { syncDirectoryImpl: this.syncPublicationDirectoryImpl, onPublished: () => { published = true; } });
            } catch (error) {
                if (!published) throw error;
                // This live invocation still owns the store lock and its exact
                // locally created intent; begin has not returned to the uploader.
                // Preserve the guard, recording that proof instead of guessing
                // from a predecessor's visible intent after a crash or readback.
                const result = { ok: false, status: 'not_started', artifactId: metadata.artifactId,
                    error: { code: 'FEEDBACK_SUBMISSION_FAILED',
                        message: 'This call did not start upload. Inspect the handoff diagnostics and existing authorization before continuing.',
                        stage: 'handoff', retryable: false, details: feedbackDiagnostics(error, 'handoff_submit') } };
                const publicationFailure = Object.assign(new Error('Upload intent publication failed.', { cause: error }), { code: error?.code });
                try {
                    await this.recordUploadOutcomeUnlocked({ path, intent }, result);
                    // The parent entry may still be unflushed. Losing this entire
                    // no-request attempt in a crash cannot erase an actual PUT.
                    publicationFailure.uploadNotStarted = result;
                } catch (recoveryError) { publicationFailure.recoveryError = recoveryError; }
                throw publicationFailure;
            }
            return { path, intent };
        });
    }
    async recordUploadOutcome(attempt, result) {
        return this.locked(() => this.recordUploadOutcomeUnlocked(attempt, result));
    }
    async recordUploadOutcomeUnlocked(attempt, result) {
        const persisted = await readRecord(join(attempt.path, 'intent.json'));
        if (!validIntent(persisted) || encoded(persisted) !== encoded(attempt.intent)) throw invalid();
        if (await readRecord(join(attempt.path, 'terminal.json'), METADATA_BYTES, true)) throw invalid();
        const record = { version: 1, attemptId: attempt.intent.attemptId, artifactId: attempt.intent.artifactId, recordedAtMs: this.now(), result };
        const bytes = Buffer.from(encoded(record));
        if (bytes.length > METADATA_BYTES) throw failure('storage_capacity');
        await this.beforePublishTerminal?.(record);
        const path = join(attempt.path, 'terminal-reserve');
        const handle = await open(path, 'r+');
        try { await handle.writeFile(bytes); await handle.truncate(bytes.length); await handle.sync(); } finally { await handle.close(); }
        await rename(path, join(attempt.path, 'terminal.json'));
        try { await this.syncDirectoryImpl(attempt.path); }
        catch (error) {
            // File data is flushed, but publication durability is unconfirmed.
            // Preserve that evidence privately and leave the immutable intent as
            // the recovery guard instead of reporting an uncommitted receipt.
            await rename(join(attempt.path, 'terminal.json'), join(attempt.path, 'unconfirmed-terminal.json'));
            throw error;
        }
    }
}
