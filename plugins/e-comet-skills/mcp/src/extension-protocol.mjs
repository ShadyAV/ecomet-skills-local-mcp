import { EXTENSION_PROTOCOL_VERSION } from './config.mjs';
import { safeExternalToolError } from './tool-errors.mjs';
import { encodeFrame } from './websocket.mjs';

const localMessage = (id, type, payload) => ({ id, type, payload });

export const createExtensionProtocol = ({
    connections,
    requestBroker,
    handoff,
    sessionNonce,
    send,
    log,
    broadcastStatus,
}) => {
    const handleMessage = async (state, rawMessage) => {
        const socket = state.socket;
        let message;
        try {
            message = JSON.parse(rawMessage);
        } catch {
            return;
        }

        const isMessage =
            typeof message?.id === 'string' &&
            message.id.length > 0 &&
            typeof message.type === 'string' &&
            message.payload &&
            typeof message.payload === 'object' &&
            !Array.isArray(message.payload);
        if (!isMessage) return;

        const { payload, type } = message;
        if (type === 'hello_ack') {
            if (state.extensionHandshakeComplete) {
                log('rejected duplicate extension hello_ack');
                socket.end(encodeFrame('', 0x8));
                return;
            }
            if (message.id !== state.helloId || payload.sessionNonce !== sessionNonce) {
                log('rejected extension hello_ack with an invalid session nonce');
                socket.end(encodeFrame('', 0x8));
                return;
            }
            if (payload.protocolVersion !== EXTENSION_PROTOCOL_VERSION) {
                log(`rejected extension protocol ${payload.protocolVersion}; expected ${EXTENSION_PROTOCOL_VERSION}`);
                socket.end(encodeFrame('', 0x8));
                return;
            }

            state.extensionHandshakeComplete = true;
            if (connections.extensionSocket && connections.extensionSocket !== socket) {
                requestBroker.invalidateAuthorizationWork();
            }
            const previousSocket = connections.connectExtension(
                socket,
                Array.isArray(payload.capabilities) && payload.capabilities.includes('browser_job')
            );
            previousSocket?.end(encodeFrame('', 0x8));
            handoff.markRoutable(connections.effectiveExtensionReady ?? connections.extensionReady);
            log(`extension connected, version ${payload.extensionVersion || 'unknown'}`);
            broadcastStatus();
            return;
        }

        if (!state.extensionHandshakeComplete) {
            log('rejected extension operational message before hello_ack');
            socket.end(encodeFrame('', 0x8));
            return;
        }

        if (type === 'ping') {
            send(socket, localMessage(message.id, 'pong', { at: Date.now() }));
            return;
        }

        if (type === 'browser_job_authorize_result') {
            if (payload.error) {
                requestBroker.rejectAuthorization(message.id, safeExternalToolError(payload.error));
            } else {
                requestBroker.resolveAuthorization(message.id, payload.authorization);
            }
            return;
        }

        if (type !== 'wb_fetch_result') return;
        if (typeof payload.response?.error === 'string') {
            const code = typeof payload.response.code === 'string' ? payload.response.code : 'WB_FETCH_FAILED';
            const authorizationFailure =
                code === 'BROWSER_JOB_NOT_AUTHORIZED' ||
                code === 'BROWSER_JOB_EXPIRED' ||
                code === 'BROWSER_JOB_URL_NOT_ALLOWED';
            const retryable = code === 'BROWSER_JOB_NOT_AUTHORIZED' || code === 'BROWSER_JOB_EXPIRED';
            requestBroker.rejectFetch(
                message.id,
                safeExternalToolError(
                    {
                        code,
                        message: payload.response.error,
                        stage: authorizationFailure ? 'authorization' : 'execution',
                        retryable,
                    },
                    'Wildberries request failed.'
                )
            );
        } else {
            requestBroker.resolveFetch(message.id, payload.response, { includeRequestId: true });
        }
    };

    const onDisconnect = (state) => {
        if (!connections.disconnectExtension(state.socket)) return false;
        requestBroker.rejectPendingRequests('Extension disconnected before returning the WB response');
        requestBroker.rejectPendingAuthorizations('Extension disconnected before authorizing the browser job');
        log('extension disconnected');
        broadcastStatus();
        return true;
    };

    return { handleMessage, onDisconnect };
};
