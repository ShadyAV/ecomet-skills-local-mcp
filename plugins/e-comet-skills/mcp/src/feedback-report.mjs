import { FEEDBACK_KINDS } from './config.mjs';
import { FeedbackPreparationError } from './feedback-errors.mjs';

const FEEDBACK_KIND_SET = new Set(FEEDBACK_KINDS);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const normalizeText = (value) => {
    if (typeof value !== 'string') throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    const normalized = value.replace(/\r\n?/g, '\n');
    if (CONTROL_CHARACTERS.test(normalized)) throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    return normalized;
};

const redactCookieValues = (value) =>
    value.replace(/\b(set-cookie|cookie)\s*:\s*([^\n]*)/gi, (_match, header, cookieText) => {
        const redacted = cookieText
            .split(';')
            .map((segment) => {
                const delimiter = segment.indexOf('=');
                return delimiter === -1 ? '[REDACTED]' : `${segment.slice(0, delimiter).trim()}=[REDACTED]`;
            })
            .join('; ');
        return `${header}: ${redacted}`;
    });

const redactJsonCredentialValues = (value) =>
    value.replace(
        /("(?:authorization|proxy-authorization|(?:x-)?api[_-]?key|cookie|set-cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
        '$1"[REDACTED]"',
    );

const redactAuthorizationHeaders = (value) =>
    value.replace(/\b(proxy-authorization|authorization)\s*:\s*([^\n]*)/gi, (_match, header, headerValue) =>
        /^bearer\s+/i.test(headerValue) ? `${header}: Bearer [REDACTED]` : `${header}: [REDACTED]`,
    );

export const redactFeedbackText = (value) => {
    if (typeof value !== 'string') throw new TypeError('Feedback text must be a string');
    return redactAuthorizationHeaders(redactCookieValues(redactJsonCredentialValues(value)))
        .replace(/\bbearer\s+[^\s;,]+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:x-)?api[_-]?key\s*([:=])\s*[^\s;,&}\]]+/gi, (_match, delimiter) => `api_key${delimiter}[REDACTED]`)
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
};

const copyString = (value) => (typeof value === 'string' ? value : undefined);
const copyBoolean = (value) => (typeof value === 'boolean' ? value : undefined);
const copyPositiveInteger = (value) => (Number.isSafeInteger(value) && value > 0 ? value : undefined);
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

export const selectFeedbackDiagnostics = (bridgeStatus) => {
    if (!bridgeStatus || typeof bridgeStatus !== 'object' || Array.isArray(bridgeStatus)) return {};
    const extension = bridgeStatus.extension && typeof bridgeStatus.extension === 'object' && !Array.isArray(bridgeStatus.extension)
        ? compact({
              state: copyString(bridgeStatus.extension.state),
              route: copyString(bridgeStatus.extension.route),
              version: copyString(bridgeStatus.extension.version),
              lastConnectedAt: copyString(bridgeStatus.extension.lastConnectedAt),
              lastDisconnectedAt: copyString(bridgeStatus.extension.lastDisconnectedAt),
              ozonSellerPromotionReportSupported: copyBoolean(bridgeStatus.extension.ozonSellerPromotionReportSupported),
          })
        : undefined;
    const peer = bridgeStatus.peer && typeof bridgeStatus.peer === 'object' && !Array.isArray(bridgeStatus.peer)
        ? compact({
              bridgeVersion: copyString(bridgeStatus.peer.bridgeVersion),
              browserContextPropagationSupported: copyBoolean(bridgeStatus.peer.browserContextPropagationSupported),
          })
        : undefined;
    const browserContext = bridgeStatus.browserContext && typeof bridgeStatus.browserContext === 'object' && !Array.isArray(bridgeStatus.browserContext)
        ? compact({
              state: copyString(bridgeStatus.browserContext.state),
              wbTabConnected: copyBoolean(bridgeStatus.browserContext.wbTabConnected),
              sellerTabConnected: copyBoolean(bridgeStatus.browserContext.sellerTabConnected),
          })
        : undefined;
    return compact({
        bridgeVersion: copyString(bridgeStatus.bridgeVersion),
        bridgeGeneration: copyPositiveInteger(bridgeStatus.bridgeGeneration),
        controlProtocolVersion: copyPositiveInteger(bridgeStatus.controlProtocolVersion),
        extensionProtocolVersion: copyPositiveInteger(bridgeStatus.extensionProtocolVersion),
        state: copyString(bridgeStatus.state),
        extension: extension && Object.keys(extension).length > 0 ? extension : undefined,
        peer: peer && Object.keys(peer).length > 0 ? peer : undefined,
        browserContext: browserContext && Object.keys(browserContext).length > 0 ? browserContext : undefined,
    });
};

/** @param {{ kind?: string, summary?: string, details?: string, diagnostics?: unknown, includeTranscript?: boolean }} input */
export const renderFeedbackReport = ({ kind, summary, details, diagnostics, includeTranscript } = {}) => {
    // WHY: report validation owns this safe category before transcript or artifact I/O can begin.
    if (!FEEDBACK_KIND_SET.has(kind)) throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    if (typeof includeTranscript !== 'boolean') throw new FeedbackPreparationError('FEEDBACK_INPUT_INVALID');
    const normalizedSummary = redactFeedbackText(normalizeText(summary));
    const normalizedDetails = redactFeedbackText(normalizeText(details));
    const selectedDiagnostics = selectFeedbackDiagnostics(diagnostics);
    const report = [
        '<!-- e-comet-feedback:v1 -->',
        '# e-Comet issue report',
        '',
        '## Kind',
        kind,
        '',
        '## Summary',
        normalizedSummary,
        '',
        '## Details',
        normalizedDetails,
        '',
        '## Current diagnostics',
        '```json',
        JSON.stringify(selectedDiagnostics),
        '```',
        '',
        '## Privacy',
        `Transcript: ${includeTranscript ? 'included' : 'not included'}`,
        '',
    ].join('\n');
    return Buffer.from(report, 'utf8');
};
