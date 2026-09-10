export const FEEDBACK_HOST_ADAPTER_VERSION = 1;

const UUID_V4_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export const feedbackHostAdapterMarkerSchema = {
    type: 'object',
    properties: {
        version: { const: FEEDBACK_HOST_ADAPTER_VERSION },
        operationId: { type: 'string', pattern: UUID_V4_RE.source },
        nonce: { type: 'string', pattern: NONCE_RE.source },
    },
    required: ['version', 'operationId', 'nonce'],
    additionalProperties: false,
};

const INPUT_KEYS = {
    prepare_e_comet_feedback: new Set(['kind', 'summary', 'details', 'includeTranscript', 'feedbackAdapter']),
    submit_e_comet_feedback: new Set(['artifactId', 'feedbackAdapter']),
};

export const hasFeedbackHostAdapterMarker = (input) =>
    input !== null && typeof input === 'object' && Object.hasOwn(input, 'feedbackAdapter');

export const isValidFeedbackHostAdapterInput = (targetTool, input) => {
    const allowed = INPUT_KEYS[targetTool];
    const marker = input?.feedbackAdapter;
    if (!allowed || input === null || typeof input !== 'object' || Array.isArray(input)) return false;
    if (Object.keys(input).some((key) => !allowed.has(key))) return false;
    if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return false;
    if (Object.keys(marker).length !== 3 || !['version', 'operationId', 'nonce'].every((key) => Object.hasOwn(marker, key))) return false;
    return marker.version === FEEDBACK_HOST_ADAPTER_VERSION
        && typeof marker.operationId === 'string'
        && typeof marker.nonce === 'string'
        && UUID_V4_RE.test(marker.operationId)
        && NONCE_RE.test(marker.nonce);
};

const messages = {
    prepare_e_comet_feedback: 'The host feedback preparation result is unavailable. Do not authorize or submit feedback from this result.',
    submit_e_comet_feedback: 'The host feedback submission outcome is unconfirmed. Re-invoke submit_e_comet_feedback with the same artifactId to inspect the saved host outcome; a prior attempt makes this read-only recovery without another upload. Do not request another grant or report success without a trusted saved receipt.',
};

export const feedbackHostResultUnavailable = (targetTool, marker) => ({
    ok: false,
    status: 'host_result_unavailable',
    adapter: {
        version: marker.version,
        operationId: marker.operationId,
        nonce: marker.nonce,
        targetTool,
    },
    error: {
        code: 'FEEDBACK_HOST_RESULT_UNAVAILABLE',
        message: messages[targetTool],
        stage: 'handoff',
        retryable: false,
    },
});
