import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MAX_MCP_MESSAGE_BYTES } from '../mcp/src/config.mjs';
import { prepareECometFeedback, submitECometFeedback } from '../mcp/src/feedback-tools.mjs';
import { registerFeedbackArtifact, loadVerifiedFeedbackArtifact, retireFeedbackArtifact } from '../mcp/src/feedback-artifact-store.mjs';
import { putFeedbackArchive } from '../mcp/src/feedback-upload.mjs';
import { feedbackPreparationFailure } from '../mcp/src/feedback-errors.mjs';
import { feedbackDiagnostics } from '../mcp/src/feedback-diagnostics.mjs';
import { FEEDBACK_HOST_ADAPTER_VERSION, feedbackHostResultUnavailable, isValidFeedbackHostAdapterInput } from '../mcp/src/feedback-host-adapter.mjs';
import { toolInputSchemas, validateSchemaValue } from '../mcp/src/tool-schemas.mjs';
import { claimUploadGrant, stagePreparedArtifact, prepareInputWithTrustedTranscript, fitPrepareWireInput, cloudPostToolOutput as postOutput } from './feedback-handoff.mjs';
import { CloudFeedbackStore, cloudPaths } from './feedback-cloud-state.mjs';

const PREFIX = 'mcp__remote-devices__plugin_e-comet-skills_e-comet-local__';
export const HOOK_BUDGET_MS = 150_000;
const UPLOAD_RESERVE_MS = 130_000;
const GRANT_START_WINDOW_MS = 30_000;
const refusalReason = (remainingBudget, remainingGrant) => remainingBudget < UPLOAD_RESERVE_MS
    ? 'insufficient_execution_budget'
    : remainingGrant < GRANT_START_WINDOW_MS ? 'FEEDBACK_GRANT_REFRESH_REQUIRED' : undefined;
// These fixed-width sizing placeholders never leave this process. The store
// generates the actual random marker after the report has been fitted.
const CLOUD_WIRE_FIELDS = { feedbackAdapter: {
    version: FEEDBACK_HOST_ADAPTER_VERSION, operationId: '0'.repeat(36), nonce: '0'.repeat(43),
} };
const invalid = () => Object.assign(new Error('The trusted cloud feedback operation could not be verified.'), { feedbackReason: 'invalid_state' });
const parseHostJson = value => {
    try { return JSON.parse(value); }
    catch (error) { throw Object.assign(invalid(), { cause: error }); }
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value);
// JSON object member order is transport formatting, not part of the trusted value.
const equal = isDeepStrictEqual;
const blocksUpload = outcome => outcome && outcome.result.status !== 'not_started';
const hook = value => ({ exitCode: 0, stdout: json({ hookSpecificOutput: value }), stderr: '' });
const recoveryOutput = result => hook({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    'This repeat call was blocked. The saved host outcome below is read-only recovery; no new upload was started. Do not request another grant or send this artifact again. ' + json(result) });
const safeFailure = (error, artifactId, status = 'uncertain', code = 'FEEDBACK_SUBMISSION_FAILED') => ({
    ok: false, status, ...(artifactId ? { artifactId } : {}), error: { code,
        message: code === 'FEEDBACK_GRANT_MISSING'
            ? 'No upload grant is staged for this artifact. This call did not start upload. If report_issue has not been called for the prepared artifact, call it once with the prepared kind and size_bytes. If it already returned, inspect that result and handoff evidence before repeating it.'
            : code === 'FEEDBACK_GRANT_REFRESH_REQUIRED'
                ? 'The upload grant cannot cover the required start window. This call did not start upload. Call report_issue again for the same prepared artifact, preserving the existing history choice.'
                : status === 'not_started'
                    ? error?.code === 'FEEDBACK_ARTIFACT_MISMATCH'
                        ? 'The staged grant belongs to a different prepared artifact. This call did not start upload. Inspect the latest prepared result and authorization before continuing.'
                        : 'This call did not start upload. Inspect the handoff diagnostics and existing authorization before continuing.'
                    : 'The trusted cloud feedback operation could not complete. Inspect the saved same-artifact outcome before any further action.',
        stage: ['UPLOAD_REJECTED', 'UPLOAD_UNCERTAIN'].includes(code) ? 'upload' : status === 'not_started' ? 'handoff' : 'submit',
        retryable: false, details: feedbackDiagnostics(error, 'handoff_submit') },
});
const trustedField = (event, snake, camel, max = 512) => {
    const value = event[snake] ?? event[camel];
    if (event[snake] !== undefined && event[camel] !== undefined && !equal(event[snake], event[camel])) throw invalid();
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max) throw invalid();
    return value;
};
const hostValue = (event, snake, camel) => {
    if (event[snake] !== undefined && event[camel] !== undefined && !equal(event[snake], event[camel])) throw invalid();
    return event[snake] ?? event[camel];
};
const authoredInput = (target, value) => {
    const keys = target === 'prepare_e_comet_feedback' ? ['kind', 'summary', 'details', 'includeTranscript'] : ['artifactId'];
    if (!record(value) || Object.keys(value).some(key => !keys.includes(key)) || !validateSchemaValue(value, toolInputSchemas[target]))
        throw Object.assign(new Error('The feedback arguments are invalid.'), { feedbackReason: 'invalid_input' });
    const input = Object.fromEntries(keys.map(key => [key, value[key]]));
    return input;
};

// Verified host representations only, with one bounded serialized layer. Never
// recurse through arbitrary response properties or accept a tool_output alias.
export const normalizeCloudResponse = response => {
    if (Buffer.byteLength(json(response) ?? '') > MAX_MCP_MESSAGE_BYTES) throw invalid();
    if (typeof response === 'string') response = parseHostJson(response);
    const candidates = [];
    let content;
    if (Array.isArray(response)) content = response;
    else if (record(response)) {
        if (response.isError !== undefined && response.isError !== false) throw invalid();
        if (response.status === 'host_result_unavailable') candidates.push(response);
        else {
            for (const key of ['structuredContent', 'structured_content']) if (Object.hasOwn(response, key)) candidates.push(response[key]);
            if (response.content !== undefined && !Array.isArray(response.content)) throw invalid();
            content = response.content;
        }
    } else throw invalid();
    for (const item of content ?? []) {
        if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') throw invalid();
        candidates.push(parseHostJson(item.text));
    }
    if (!candidates.length || candidates.some(item => !equal(item, candidates[0]))) throw invalid();
    return candidates[0];
};

export const processCloudFeedbackEvent = async (event, options = {}) => {
    const started = options.cloudStartedAt ?? (options.cloud?.monotonicNow ?? (() => performance.now()))();
    const monotonicNow = options.cloud?.monotonicNow ?? (() => performance.now());
    const now = options.cloud?.now ?? Date.now;
    const binding = { sessionId: trustedField(event, 'session_id', 'sessionId'),
        toolName: trustedField(event, 'tool_name', 'toolName'), callId: trustedField(event, 'tool_use_id', 'toolUseId') };
    const eventName = trustedField(event, 'hook_event_name', 'hookEventName');
    const target = binding.toolName.slice(PREFIX.length);
    if (!binding.toolName.startsWith(PREFIX) || !['prepare_e_comet_feedback', 'submit_e_comet_feedback'].includes(target)) throw invalid();
    const paths = cloudPaths(options.env ?? process.env);
    // Explicit artifactDirectory prevents canonical legacy/native-root fallback.
    const artifactOptions = { artifactDirectory: paths.artifacts, now };
    const retireArtifact = options.cloud?.retireArtifact ?? (value => retireFeedbackArtifact(value, artifactOptions));
    const store = new CloudFeedbackStore(paths, { now, ...options.cloud?.state });
    const input = hostValue(event, 'tool_input', 'toolInput');
    if (eventName === 'PreToolUse') {
        const authored = authoredInput(target, input);
        if (target === 'submit_e_comet_feedback') {
            // Lookup comes before staging, claim/grant access, or any upload. It
            // works after archive, grant and completed operation cleanup.
            const outcome = await store.readArtifactOutcome(binding.sessionId, authored.artifactId);
            if (blocksUpload(outcome)) {
                if (outcome.result.status === 'uploaded') await retireArtifact({ artifactId: authored.artifactId }).catch(() => undefined);
                return recoveryOutput(outcome.result);
            }
        }
        const effective = target === 'prepare_e_comet_feedback'
            ? fitPrepareWireInput(prepareInputWithTrustedTranscript({ ...event, tool_input: authored, toolInput: authored }), CLOUD_WIRE_FIELDS) : authored;
        const { transcriptPath, ...fitted } = effective;
        const marker = await store.stage(binding, { authored: fitted, ...(transcriptPath ? { transcriptPath } : {}) }, authored);
        return hook({ hookEventName: 'PreToolUse', updatedInput: { ...fitted, feedbackAdapter: marker } });
    }
    if (eventName !== 'PostToolUse') throw invalid();
    const op = await store.readOperation(binding);
    const marker = op.marker;
    const postAuthored = record(input) ? { ...input } : undefined;
    if (postAuthored && Object.hasOwn(postAuthored, 'feedbackAdapter')) {
        if (!isValidFeedbackHostAdapterInput(target, postAuthored) || !equal(postAuthored.feedbackAdapter, marker)) throw invalid();
        delete postAuthored.feedbackAdapter;
    }
    const normalized = authoredInput(target, postAuthored);
    if (!store.inputMatches(op, normalized)) throw invalid();
    const response = normalizeCloudResponse(hostValue(event, 'tool_response', 'toolResponse'));
    if (!equal(response, feedbackHostResultUnavailable(target, marker))) throw invalid();
    const claim = await store.claimOperation(binding);
    if (claim.result) return postOutput(claim.result);
    if (!claim.owned) return postOutput(target === 'prepare_e_comet_feedback'
        ? feedbackPreparationFailure(invalid()) : safeFailure(undefined, normalized.artifactId));
    let result;
    let grantClaimed = false;
    let notStarted;
    let loadedMetadata;
    // The cloud hook prepares and uploads inside this process, so it is itself the trusted party: it
    // never reads the shared hook secret and issues no signature to verify against itself.
    const trusted = { verifySignature: () => true, now };
    const feedbackSession = createHash('sha256').update(binding.sessionId, 'utf8').digest('hex');
    try {
        if (target === 'prepare_e_comet_feedback') {
            const effective = { ...op.input.authored, ...(op.input.transcriptPath ? { transcriptPath: op.input.transcriptPath } : {}) };
            result = await prepareECometFeedback({ ...effective, feedbackSession }, {
                ...trusted, getBridgeStatus: () => ({ nativeBridgeDiagnostics: 'unavailable_in_cloud_hook' }),
                registerArtifact: value => registerFeedbackArtifact(value, artifactOptions),
                ...(options.cloud?.readTranscript ? { readTranscript: options.cloud.readTranscript } : {}),
            });
            const { artifactId, kind, sizeBytes, sha256, transcriptIncluded } = result;
            await stagePreparedArtifact({ dataDirectory: paths.handoff, sessionId: binding.sessionId,
                metadata: { artifactId, kind, sizeBytes, sha256, transcriptIncluded }, nowMs: now() });
        } else {
            const outcome = await store.readArtifactOutcome(binding.sessionId, normalized.artifactId);
            if (blocksUpload(outcome)) result = outcome.result;
            else {
                const transport = await claimUploadGrant({ dataDirectory: paths.handoff, sessionId: binding.sessionId,
                    artifactId: normalized.artifactId, targetTool: target, nowMs: now() });
                grantClaimed = true;
                const effective = { ...normalized, ...transport, feedbackSession };
                result = await submitECometFeedback(effective, {
                    ...trusted, retireArtifact,
                    loadArtifact: async value => {
                        const artifact = await (options.cloud?.loadArtifact ?? (request => loadVerifiedFeedbackArtifact(request, artifactOptions)))(value);
                        loadedMetadata = { artifactId: normalized.artifactId, sizeBytes: effective.expectedSize, sha256: effective.expectedSha256, transcriptIncluded: artifact.transcriptIncluded };
                        return artifact;
                    },
                    upload: async uploadInput => {
                        // Canonical validation has already verified the trusted fields and the
                        // immutable ZIP bytes. This is the sole PUT seam.
                        const previous = await store.readArtifactOutcome(binding.sessionId, normalized.artifactId);
                        if (blocksUpload(previous)) throw invalid();
                        const refuse = reason => {
                            notStarted = { ...safeFailure(undefined, normalized.artifactId, 'not_started', reason), reason };
                            throw invalid();
                        };
                        const beforeIntentRefusal = refusalReason(HOOK_BUDGET_MS - (monotonicNow() - started), effective.expiresAt * 1000 - now());
                        if (beforeIntentRefusal) refuse(beforeIntentRefusal);
                        let attempt;
                        try { attempt = await store.beginUploadAttempt(binding.sessionId, loadedMetadata); }
                        catch (error) {
                            // A concurrent or partial attempt is never a no-request outcome for this
                            // artifact. An unreadable guard stays uncertain.
                            try {
                                if (!await store.readArtifactOutcome(binding.sessionId, normalized.artifactId))
                                    notStarted = safeFailure(error, normalized.artifactId, 'not_started');
                            } catch (readbackError) {
                                // Failure to inspect the guard must not erase the initiating cause,
                                // or prove that replay is safe.
                                throw Object.assign(new Error('Upload state readback failed.', { cause: error }), { readbackError });
                            }
                            throw error;
                        }
                        // Admission is awaited work; recheck immediately before constructing the request.
                        const afterIntentRefusal = refusalReason(HOOK_BUDGET_MS - (monotonicNow() - started), effective.expiresAt * 1000 - now());
                        if (afterIntentRefusal) {
                            // No request was constructed, so this owner releases its own guard and the
                            // next submit can authorize the same artifact again.
                            notStarted = { ...safeFailure(undefined, normalized.artifactId, 'not_started', afterIntentRefusal), reason: afterIntentRefusal };
                            // The refusal is known before the guard is released. A guard that cannot be
                            // removed is recorded as this no-request outcome instead, which a fresh
                            // authorization may replace; only a failure of both leaves it uncertain.
                            try { await store.releaseUploadAttempt(attempt); }
                            catch { await store.recordUploadOutcome(attempt, notStarted).catch(() => undefined); }
                            throw invalid(); // This owner never invokes the uploader.
                        }
                        try {
                            await (options.cloud?.upload ?? putFeedbackArchive)(uploadInput);
                        } catch (error) {
                            const status = error?.code === 'UPLOAD_REJECTED' ? 'rejected' : 'uncertain';
                            await store.recordUploadOutcome(attempt, safeFailure(error, normalized.artifactId, status, status === 'rejected' ? 'UPLOAD_REJECTED' : 'UPLOAD_UNCERTAIN')).catch(() => undefined);
                            throw error;
                        }
                        // Do not resolve until the receipt is recorded: canonical submit retires the
                        // ZIP immediately after this.
                        await store.recordUploadOutcome(attempt, { ok: true, status: 'uploaded', artifactId: normalized.artifactId, transcriptIncluded: loadedMetadata.transcriptIncluded });
                    },
                });
                if (notStarted) result = notStarted;
                const recorded = await store.readArtifactOutcome(binding.sessionId, normalized.artifactId);
                // A previous no-request terminal cannot replace this call's fresh
                // refusal. A possible/confirmed upload still takes precedence.
                if (recorded && (!notStarted || blocksUpload(recorded))
                    && (recorded.terminal || result.status !== 'uncertain')) result = recorded.result;
            }
        }
    } catch (error) {
        if (target === 'prepare_e_comet_feedback' && result?.status === 'prepared') {
            // Initial staging never exposed this archive to the model. Retire it
            // through canonical cleanup instead of leaving unreachable quota use.
            await retireArtifact({ artifactId: result.artifactId }).catch(() => undefined);
        }
        // A later bookkeeping read failure must not replace an already captured
        // submission failure's diagnostic cause. Neither permits another PUT.
        result = target === 'prepare_e_comet_feedback' ? feedbackPreparationFailure(error)
            : result?.status === 'uncertain' ? result : safeFailure(error, normalized.artifactId, 'uncertain');
        if (target === 'submit_e_comet_feedback') {
            try {
                const recorded = await store.readArtifactOutcome(binding.sessionId, normalized.artifactId);
                if (blocksUpload(recorded)) result = recorded.result;
                else if (notStarted) result = notStarted;
                else if (recorded) result = recorded.result;
                else if (!grantClaimed)
                    // Claim acquisition precedes the only upload seam. A missing
                    // artifact guard establishes no earlier attempt either.
                    result = safeFailure(error, normalized.artifactId, 'not_started',
                        ['FEEDBACK_GRANT_MISSING', 'FEEDBACK_GRANT_REFRESH_REQUIRED'].includes(error?.code) ? error.code : 'FEEDBACK_SUBMISSION_FAILED');
            } catch {
                // This invocation's no-PUT fact is still known, but an unreadable
                // artifact guard cannot exclude another invocation's upload.
                if (notStarted) result = { ...result, error: { ...result.error,
                    message: 'This call did not start upload, but the saved outcome of other attempts could not be read. Do not resend this artifact until its upload history can be established.' } };
            }
        }
    }
    try { await store.finishOperation(binding, result); }
    catch (error) {
        // The archive and handoff are already published for a successful prepare.
        // Return its ID even if the operation receipt fails; retiring it could
        // invalidate a result.json already committed before redaction failed.
        // Lost output before result publication still cannot replay that prepare.
        // Ancillary persistence also cannot downgrade a durable uploaded receipt.
        if (target === 'submit_e_comet_feedback' && !['uploaded', 'not_started'].includes(result.status)) result = safeFailure(error, normalized.artifactId, 'uncertain');
    }
    return postOutput(result);
};
