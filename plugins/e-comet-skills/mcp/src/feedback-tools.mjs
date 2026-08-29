import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { FEEDBACK_MAX_SUMMARY_LENGTH, FEEDBACK_MAX_TRANSCRIPT_BYTES } from './config.mjs';
import { consumeFeedbackClaim } from './feedback-claim.mjs';
import { loadVerifiedFeedbackArtifact, registerFeedbackArtifact, retireFeedbackArtifact } from './feedback-artifact-store.mjs';
import { redactFeedbackText, renderFeedbackReport } from './feedback-report.mjs';
import { createFeedbackZip } from './feedback-zip.mjs';
import { putFeedbackArchive } from './feedback-upload.mjs';

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

class FeedbackPreparationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'FeedbackPreparationError';
        this.code = code;
    }
}

const transcriptUnavailable = () => new FeedbackPreparationError('TRANSCRIPT_UNAVAILABLE', 'The requested feedback transcript is unavailable.');
const claimInvalid = () => new FeedbackPreparationError('FEEDBACK_CLAIM_INVALID', 'The trusted feedback handoff claim is invalid or has expired.');
const safeSummary = (summary) => redactFeedbackText(summary.replace(/\r\n?/g, '\n')).slice(0, FEEDBACK_MAX_SUMMARY_LENGTH);
const safeArtifactId = (artifactId) => (typeof artifactId === 'string' && ARTIFACT_ID.test(artifactId) ? artifactId : undefined);

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

const readBoundedDescriptor = async (handle, size) => {
    // WHY: the validated descriptor size freezes the consented snapshot, excluding later appends and rejecting truncation.
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset) throw transcriptUnavailable();
        if (bytesRead === 0) throw transcriptUnavailable();
        offset += bytesRead;
    }
    return bytes;
};

/**
 * Reads a transcript only when its path continues to resolve to the same regular file as the opened descriptor.
 * @param {string} path
 * @param {{ lstatImpl?: typeof import('node:fs/promises').lstat, openImpl?: typeof open, maxBytes?: number }} options
 */
export const readTrustedFeedbackTranscript = async (path, options = {}) => {
    const { lstatImpl = lstat, openImpl = open, maxBytes = FEEDBACK_MAX_TRANSCRIPT_BYTES } = options;
    if (typeof path !== 'string' || path.length === 0) throw transcriptUnavailable();
    if (typeof lstatImpl !== 'function' || typeof openImpl !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw transcriptUnavailable();
    let handle;
    try {
        const before = await lstatImpl(path);
        if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw transcriptUnavailable();
        // O_NOFOLLOW blocks replacement by a link on supported platforms; the identity checks are required where
        // that flag is unavailable or ignored (notably Windows reparse points).
        handle = await openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const descriptor = await handle.stat();
        const after = await lstatImpl(path);
        if (!descriptor.isFile() || descriptor.size > maxBytes || !after.isFile() || after.isSymbolicLink() || !sameFile(before, descriptor) || !sameFile(descriptor, after)) {
            throw transcriptUnavailable();
        }
        return await readBoundedDescriptor(handle, descriptor.size);
    } catch (error) {
        if (error?.code === 'TRANSCRIPT_UNAVAILABLE') throw error;
        throw transcriptUnavailable();
    } finally {
        await handle?.close().catch(() => undefined);
    }
};

const readTrustedTranscript = (path) => readTrustedFeedbackTranscript(path);

/**
 * Creates and stores an immutable feedback archive. transcriptPath is injected by the trusted host hook.
 * @param {{ kind?: string, summary?: string, details?: string, includeTranscript?: boolean, transcriptPath?: string, feedbackClaim?: string, feedbackSession?: string }} input
 * @param {{ getBridgeStatus?: () => unknown, registerArtifact?: typeof registerFeedbackArtifact, readTranscript?: (path: string) => Promise<Buffer>, consumeClaim?: typeof consumeFeedbackClaim }} dependencies
 */
export const prepareECometFeedback = async (input = {}, dependencies = {}) => {
    const { getBridgeStatus, registerArtifact = registerFeedbackArtifact, readTranscript = readTrustedTranscript, consumeClaim = consumeFeedbackClaim } = dependencies;
    if (typeof getBridgeStatus !== 'function' || typeof registerArtifact !== 'function' || typeof readTranscript !== 'function' || typeof consumeClaim !== 'function') {
        throw new TypeError('Feedback preparation dependencies are invalid');
    }
    const { kind, summary, details, includeTranscript, transcriptPath, feedbackClaim, feedbackSession } = input;
    const claimInput = { kind, summary, details, includeTranscript, ...(transcriptPath === undefined ? {} : { transcriptPath }) };
    try {
        // WHY: hook fields are only data until the local process consumes the matching private capability.
        // Burning it first prevents a skipped/untrusted hook from reaching a transcript or artifact write.
        await consumeClaim({ claimToken: feedbackClaim, sessionBinding: feedbackSession, targetTool: 'prepare_e_comet_feedback', input: claimInput });
    } catch {
        throw claimInvalid();
    }
    let transcriptBytes;
    if (includeTranscript === true) {
        try {
            transcriptBytes = await readTranscript(transcriptPath);
            if (!Buffer.isBuffer(transcriptBytes) || transcriptBytes.length > FEEDBACK_MAX_TRANSCRIPT_BYTES) throw transcriptUnavailable();
        } catch {
            throw transcriptUnavailable();
        }
    }
    let diagnostics = {};
    try {
        diagnostics = await getBridgeStatus();
    } catch {
        // Diagnostics are optional; reporting must remain possible during bridge failures.
    }
    const reportBytes = renderFeedbackReport({ kind, summary, details, diagnostics, includeTranscript });
    const archiveBytes = createFeedbackZip({ reportBytes, ...(transcriptBytes === undefined ? {} : { transcriptBytes }) });
    const artifact = await registerArtifact({ kind, includeTranscript, reportBytes, archiveBytes });
    const prepared = {
        ok: true,
        status: 'prepared',
        artifactId: artifact.artifactId,
        kind,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        transcriptIncluded: artifact.transcriptIncluded,
        summary: safeSummary(summary),
    };
    // The report is available to the MCP renderer as a local resource, but never becomes model-visible
    // structured data (and therefore cannot carry a local path into the report payload).
    Object.defineProperty(prepared, 'reportResource', { value: artifact.reportResource });
    return prepared;
};

const submitError = (artifactId, status, code, message, stage, retryable) => ({
    ok: false,
    status,
    ...(artifactId === undefined ? {} : { artifactId }),
    error: { code, message, stage, retryable },
});

const uploadFailure = (artifactId, code) => {
    if (code === 'UPLOAD_REJECTED') {
        return submitError(artifactId, 'rejected', code, 'The feedback archive upload was rejected.', 'upload', false);
    }
    if (code === 'UPLOAD_UNCERTAIN') {
        return submitError(artifactId, 'uncertain', code, 'The feedback archive upload outcome is uncertain.', 'upload', false);
    }
    return submitError(artifactId, 'failed', 'UPLOAD_GRANT_INVALID', 'The feedback upload grant is invalid or has expired.', 'grant', false);
};

/**
 * Re-verifies and uploads one stored archive. Transport fields are injected by the trusted host hook.
 * @param {{ artifactId?: string, uploadUrl?: string, requiredHeaders?: Record<string, string>, objectKey?: string, expiresAt?: number, expectedSize?: number, expectedSha256?: string, feedbackClaim?: string, feedbackSession?: string }} input
 * @param {{ loadArtifact?: typeof loadVerifiedFeedbackArtifact, retireArtifact?: typeof retireFeedbackArtifact, upload?: typeof putFeedbackArchive, now?: () => number, consumeClaim?: typeof consumeFeedbackClaim }} dependencies
 */
export const submitECometFeedback = async (input = {}, dependencies = {}) => {
    const { loadArtifact = loadVerifiedFeedbackArtifact, retireArtifact = retireFeedbackArtifact, upload = putFeedbackArchive, now = Date.now, consumeClaim = consumeFeedbackClaim } = dependencies;
    const artifactId = safeArtifactId(input.artifactId);
    if (typeof loadArtifact !== 'function' || typeof retireArtifact !== 'function' || typeof upload !== 'function' || typeof now !== 'function' || typeof consumeClaim !== 'function') {
        return uploadFailure(artifactId, 'UPLOAD_GRANT_INVALID');
    }
    const claimInput = {
        artifactId: input.artifactId,
        uploadUrl: input.uploadUrl,
        requiredHeaders: input.requiredHeaders,
        objectKey: input.objectKey,
        expiresAt: input.expiresAt,
        expectedSize: input.expectedSize,
        expectedSha256: input.expectedSha256,
    };
    try {
        // WHY: consume before artifact reads or request creation so raw transport values never confer authority.
        await consumeClaim({ claimToken: input.feedbackClaim, sessionBinding: input.feedbackSession, targetTool: 'submit_e_comet_feedback', input: claimInput });
    } catch {
        return uploadFailure(artifactId, 'UPLOAD_GRANT_INVALID');
    }
    if (
        artifactId === undefined ||
        typeof input.uploadUrl !== 'string' ||
        !input.requiredHeaders ||
        typeof input.requiredHeaders !== 'object' ||
        Array.isArray(input.requiredHeaders) ||
        typeof input.objectKey !== 'string' ||
        !Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt * 1000 <= now() ||
        !Number.isSafeInteger(input.expectedSize) ||
        input.expectedSize <= 0 ||
        typeof input.expectedSha256 !== 'string' ||
        !SHA256.test(input.expectedSha256)
    ) {
        return uploadFailure(artifactId, 'UPLOAD_GRANT_INVALID');
    }
    let artifact;
    try {
        artifact = await loadArtifact({ artifactId, expectedSize: input.expectedSize, expectedSha256: input.expectedSha256 });
        if (!artifact || !Buffer.isBuffer(artifact.bytes) || artifact.bytes.length !== input.expectedSize || artifact.transcriptIncluded !== true && artifact.transcriptIncluded !== false) {
            throw new Error('invalid artifact');
        }
    } catch {
        return submitError(artifactId, 'failed', 'ARTIFACT_UNAVAILABLE', 'The prepared feedback archive is unavailable.', 'artifact', false);
    }
    try {
        await upload({
            uploadUrl: input.uploadUrl,
            requiredHeaders: input.requiredHeaders,
            expiresAt: input.expiresAt,
            bytes: artifact.bytes,
        });
    } catch (error) {
        return uploadFailure(artifactId, error?.code);
    }
    // Retirement/tombstone reconciliation is private maintenance. Storage acceptance is the only public outcome.
    await retireArtifact({ artifactId }).catch(() => undefined);
    return { ok: true, status: 'uploaded', artifactId, transcriptIncluded: artifact.transcriptIncluded };
};
