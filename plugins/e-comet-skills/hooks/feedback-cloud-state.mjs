import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_MCP_MESSAGE_BYTES, FEEDBACK_ARTIFACT_RETENTION_MS, FEEDBACK_MAX_BYTES } from '../mcp/src/config.mjs';
import { sweepExpired } from '../mcp/src/file-retention.mjs';
import { toolOutputSchemas, validateSchemaValue } from '../mcp/src/tool-schemas.mjs';
import { feedbackHostAdapterMarkerSchema } from '../mcp/src/feedback-host-adapter.mjs';

const METADATA_BYTES = 64 * 1024;
const MAX_OPERATION_BYTES = MAX_MCP_MESSAGE_BYTES + METADATA_BYTES;
const CLOCK_SKEW_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;
const RESIDUE_NAME = /^[a-f0-9]{64}\.(?:running|[0-9a-f-]{36}\.tmp)$/;
const TERMINAL_STATUSES = ['uploaded', 'rejected', 'uncertain', 'not_started'];

const hash = value => createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = reason => Object.assign(new Error('The private cloud feedback state is unavailable.'), { feedbackReason: reason });
const invalid = () => failure('invalid_state');
const missingState = error => error?.code === 'ENOENT'
    ? Object.assign(failure('state_missing'), { code: 'ENOENT', cause: error }) : error;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const validOperationInput = input => record(input) && record(input.authored)
    && (input.transcriptPath === undefined || typeof input.transcriptPath === 'string');
const validOperationResult = (binding, result) => {
    const schema = toolOutputSchemas[binding?.toolName?.split('__').at(-1)];
    return Boolean(schema && validateSchemaValue(result, schema));
};
const validAttempt = attempt => attempt?.version === 1 && HASH.test(attempt.sessionHash)
    && UUID.test(attempt.artifactId) && UUID.test(attempt.attemptId) && HASH.test(attempt.sha256)
    && validTime(attempt.createdAtMs) && Number.isSafeInteger(attempt.sizeBytes) && attempt.sizeBytes > 0
    && attempt.sizeBytes <= FEEDBACK_MAX_BYTES && typeof attempt.transcriptIncluded === 'boolean'
    && (attempt.status === 'started'
        || (TERMINAL_STATUSES.includes(attempt.status)
            && attempt.result?.artifactId === attempt.artifactId
            && attempt.result.status === attempt.status
            && validateSchemaValue(attempt.result, toolOutputSchemas.submit_e_comet_feedback)
            && (attempt.status !== 'uploaded' || attempt.result.transcriptIncluded === attempt.transcriptIncluded)));

export const bindingKey = binding => hash(encoded([binding.sessionId, binding.toolName, binding.callId]));

export const cloudPaths = env => {
    const root = env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA;
    if (typeof root !== 'string' || !root.trim()) throw failure('storage_unavailable');
    const base = resolve(root);
    return {
        root: join(base, 'feedback-cloud-v1'),
        handoff: join(base, 'feedback-cloud-v1', 'handoff'),
        artifacts: join(base, 'feedback-cloud-v1', 'artifacts'),
    };
};

const privateDirectory = async (path, create = false) => {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalid();
    if (process.platform !== 'win32') await chmod(path, 0o700);
};

const readRecord = async (path, max = METADATA_BYTES, optional = false) => {
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) {
        if (optional && error?.code === 'ENOENT') return undefined;
        throw missingState(error);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > max) throw invalid();
    const text = await readFile(path, 'utf8');
    // Growth after the stat is not a record this process may act on.
    if (Buffer.byteLength(text, 'utf8') > max) throw invalid();
    try { return JSON.parse(text); }
    catch (error) { throw Object.assign(invalid(), { cause: error }); }
};

const serialize = (value, max) => {
    const bytes = Buffer.from(encoded(value), 'utf8');
    // Records are bounded by construction (fitted MCP input plus metadata). Overflow is a defect of
    // this process, never a capacity the user could free, so it is invalid state and not a quota.
    if (bytes.length > max) throw invalid();
    return bytes;
};
const writeExclusive = (path, value, max = METADATA_BYTES) =>
    writeFile(path, serialize(value, max), { flag: 'wx', mode: 0o600 });
const replaceRecord = async (path, value, max = METADATA_BYTES) => {
    // One owner replaces its own record: publication is a single rename, never a candidate protocol.
    const temporary = `${path.replace(/\.json$/, '')}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialize(value, max), { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, path); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
};
const isOwnName = name => RECORD_NAME.test(name) || RESIDUE_NAME.test(name);

// One record per operation with two states and one file per upload attempt, in the same operations/
// and attempts/ roots as before. Private payloads exist only while an operation is pending; every
// leftover expires by age like other local files. There is no count to refuse on, and the previous
// build's per-operation and per-attempt directories never match this grammar: they are neither swept
// nor read.
export class CloudFeedbackStore {
    constructor(paths, {
        now = Date.now,
        retentionMs = FEEDBACK_ARTIFACT_RETENTION_MS,
        beforePublishTerminal,
    } = {}) {
        Object.assign(this, { paths, now, retentionMs, beforePublishTerminal });
    }

    get operations() { return join(this.paths.root, 'operations'); }
    get attempts() { return join(this.paths.root, 'attempts'); }

    async initialize(create = false) {
        try {
            await privateDirectory(this.paths.root, create);
            await privateDirectory(this.operations, create);
            await privateDirectory(this.attempts, create);
        } catch (error) {
            // Absent state is distinct from an observed filesystem fault, but does not prove this
            // artifact was never uploaded under a lost root.
            throw create ? error : missingState(error);
        }
    }

    operationPath(binding) { return join(this.operations, `${bindingKey(binding)}.json`); }
    runningPath(binding) { return join(this.operations, `${bindingKey(binding)}.running`); }
    attemptPath(sessionId, artifactId) {
        if (!UUID.test(artifactId)) throw invalid();
        return join(this.attempts, `${hash(encoded([hash(sessionId), artifactId]))}.json`);
    }

    // Every hook run sweeps both subtrees by age alone; nothing else removes a record.
    async sweep() {
        for (const directory of [this.operations, this.attempts]) {
            await sweepExpired({ directory, ownName: isOwnName, retentionMs: this.retentionMs + CLOCK_SKEW_MS });
        }
    }

    async stage(binding, input, originalAuthored = input.authored) {
        await this.initialize(true);
        await this.sweep();
        const originalInputHash = hash(encoded(originalAuthored));
        const operation = {
            version: 1,
            state: 'pending',
            binding,
            marker: { version: 1, operationId: randomUUID(), nonce: randomBytes(32).toString('base64url') },
            input,
            originalInputHash,
            createdAtMs: this.now(),
        };
        try {
            await writeExclusive(this.operationPath(binding), operation, MAX_OPERATION_BYTES);
            return operation.marker;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            // A duplicated Pre for one call reuses its own pending marker; anything else fails closed.
            const existing = await this.readOperation(binding);
            if (existing.state !== 'pending' || existing.originalInputHash !== originalInputHash) throw invalid();
            return existing.marker;
        }
    }

    async readOperation(binding) {
        await this.initialize();
        const op = await readRecord(this.operationPath(binding), MAX_OPERATION_BYTES);
        if (
            op?.version !== 1 ||
            !['pending', 'result'].includes(op.state) ||
            encoded(op.binding) !== encoded(binding) ||
            !validateSchemaValue(op.marker, feedbackHostAdapterMarkerSchema) ||
            !HASH.test(op.originalInputHash) ||
            !validTime(op.createdAtMs) ||
            op.createdAtMs > this.now() + CLOCK_SKEW_MS ||
            this.now() - op.createdAtMs > this.retentionMs ||
            (op.state === 'pending'
                ? !validOperationInput(op.input)
                : !(HASH.test(op.inputHash) && validOperationResult(binding, op.result)))
        ) {
            throw invalid();
        }
        return op;
    }

    async claimOperation(binding) {
        const op = await this.readOperation(binding);
        if (op.state === 'result') return { result: op.result };
        try {
            await writeExclusive(this.runningPath(binding), { version: 1, startedAtMs: this.now() });
        } catch (error) {
            // A second Post for the same call never repeats protected work.
            if (error?.code === 'EEXIST') return { running: true };
            throw error;
        }
        return { owned: true };
    }

    async finishOperation(binding, result) {
        const op = await this.readOperation(binding);
        // A published outcome is written once: a replay reads it and never overwrites it.
        if (op.state === 'result') throw Object.assign(invalid(), { code: 'EEXIST' });
        if (!validOperationResult(binding, result)) throw invalid();
        await replaceRecord(this.operationPath(binding), {
            version: 1,
            state: 'result',
            binding,
            marker: op.marker,
            originalInputHash: op.originalInputHash,
            inputHash: hash(encoded(op.input.authored)),
            result,
            createdAtMs: op.createdAtMs,
            completedAtMs: this.now(),
        }, MAX_OPERATION_BYTES);
        await rm(this.runningPath(binding), { force: true }).catch(() => undefined);
    }

    inputMatches(op, input) {
        // Accept only the exact original or the exact fitted representation. Refitting Post input
        // would hide mutations inside omitted or redacted report text.
        const digest = hash(encoded(input));
        return digest === op.originalInputHash
            || digest === (op.state === 'result' ? op.inputHash : hash(encoded(op.input.authored)));
    }

    async readArtifactOutcome(sessionId, artifactId) {
        await this.initialize();
        const attempt = await readRecord(this.attemptPath(sessionId, artifactId), METADATA_BYTES, true);
        if (attempt === undefined) return undefined;
        if (!validAttempt(attempt) || attempt.sessionHash !== hash(sessionId) || attempt.artifactId !== artifactId) throw invalid();
        if (attempt.status !== 'started') return { ...attempt, terminal: true, result: attempt.result };
        // A started attempt without an outcome is uncertain: nothing here proves no request was sent.
        return {
            ...attempt,
            result: {
                ok: false,
                status: 'uncertain',
                artifactId,
                error: { code: 'UPLOAD_UNCERTAIN', message: 'An upload intent exists without a confirmed outcome. Do not send this artifact again.', stage: 'upload', retryable: false },
            },
        };
    }

    async beginUploadAttempt(sessionId, metadata) {
        await this.initialize(true);
        await this.sweep();
        // Any existing attempt blocks a fresh request, except a recorded no-request refusal: it proves the
        // uploader was never invoked, so a fresh authorization may replace it. The record is moved aside
        // rather than deleted, so two replacers cannot both pass the exclusive create below.
        const path = this.attemptPath(sessionId, metadata.artifactId);
        const existing = await this.readArtifactOutcome(sessionId, metadata.artifactId);
        if (existing !== undefined) {
            if (!(existing.terminal && existing.result.status === 'not_started')) throw failure('upload_already_started');
            const residue = `${path.replace(/\.json$/, '')}.${randomUUID()}.tmp`;
            await rename(path, residue).catch(error => { if (error?.code !== 'ENOENT') throw error; });
            await rm(residue, { force: true }).catch(() => undefined);
        }
        const intent = {
            version: 1,
            status: 'started',
            sessionHash: hash(sessionId),
            ...metadata,
            attemptId: randomUUID(),
            createdAtMs: this.now(),
        };
        try {
            await writeExclusive(path, intent);
        } catch (error) {
            if (error?.code === 'EEXIST') throw failure('upload_already_started');
            // A failed create authorized nothing: remove its bytes so the next submit can start, unless a
            // complete attempt of another process is what sits there now.
            const residue = await readRecord(path, METADATA_BYTES, true).catch(() => null);
            if (residue === undefined || residue === null || !validAttempt(residue)) await rm(path, { force: true }).catch(() => undefined);
            throw error;
        }
        return { path, intent };
    }

    async recordUploadOutcome(attempt, result) {
        const persisted = await readRecord(attempt.path);
        if (!validAttempt(persisted) || persisted.status !== 'started' || persisted.attemptId !== attempt.intent.attemptId) throw invalid();
        if (
            !TERMINAL_STATUSES.includes(result?.status) ||
            result.artifactId !== attempt.intent.artifactId ||
            !validateSchemaValue(result, toolOutputSchemas.submit_e_comet_feedback) ||
            (result.status === 'uploaded' && result.transcriptIncluded !== attempt.intent.transcriptIncluded)
        ) {
            throw invalid();
        }
        await this.beforePublishTerminal?.(result);
        await replaceRecord(attempt.path, { ...attempt.intent, status: result.status, result, recordedAtMs: this.now() });
    }

    async releaseUploadAttempt(attempt) {
        // Only the owner of an unstarted attempt may release it, and only before any request.
        const persisted = await readRecord(attempt.path, METADATA_BYTES, true);
        if (persisted?.attemptId !== attempt.intent.attemptId || persisted.status !== 'started') throw invalid();
        await rm(attempt.path, { force: true });
    }
}
