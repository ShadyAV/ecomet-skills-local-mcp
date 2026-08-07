import {
    BRIDGE_VERSION,
    CONTROL_PROTOCOL_VERSION,
    EXTENSION_PROTOCOL_VERSION,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    PEER_RECONNECT_BASE_MS,
    PEER_RECONNECT_MAX_MS,
} from './config.mjs';
import { PEER_REJECTION_CODES } from './connection-state.mjs';
import { createPeerAuthNonce, createPeerAuthProof, isValidPeerAuthNonce, peerTokensEqual } from './peer-auth.mjs';
import { peerStatusMessage } from './extension-vocabulary.mjs';
import { safeExternalToolError, ToolExecutionError, toolFailure } from './tool-errors.mjs';
import { encodeFrame } from './websocket.mjs';
import { validTimeout } from './wb-domain.mjs';

const isValidPeerIdentity = (message) =>
    message?.controlProtocolVersion === CONTROL_PROTOCOL_VERSION &&
    Number.isInteger(message.bridgeGeneration) &&
    message.bridgeGeneration >= 1 &&
    typeof message.bridgeVersion === 'string' &&
    message.bridgeVersion.length > 0 &&
    typeof message.instanceId === 'string' &&
    message.instanceId.length > 0;

const peerAuthTranscript = (client, primary) =>
    JSON.stringify([
        CONTROL_PROTOCOL_VERSION,
        client.clientNonce,
        primary.serverNonce,
        client.bridgeGeneration,
        client.bridgeVersion,
        client.instanceId,
        primary.bridgeGeneration,
        primary.bridgeVersion,
        primary.instanceId,
    ]);

export const createPeerProtocol = ({
    connections,
    requestBroker,
    handoff,
    peerToken,
    send,
    log,
    broadcastStatus,
}) => {
    const currentPeerStatus = () =>
        peerStatusMessage({
            connections,
            handoff,
            bridgeGeneration: handoff.generation,
            bridgeVersion: BRIDGE_VERSION,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
        });

    const closeState = (state) => {
        if (state.role === 'client') {
            state.socket.close();
        } else {
            state.socket.end(encodeFrame('', 0x8));
        }
    };

    const createState = (socket, { role = 'server' } = {}) => ({
        socket,
        role,
        peerHandshakeComplete: false,
        primaryProofVerified: false,
        authenticatedPrimary: null,
        pendingPeerAuth: null,
        peerGeneration: null,
        peerInstanceId: null,
        // The secondary reuses its authorize requestId as authorizationScopeId on every scoped fetch.
        authorizationLeases: new Map(),
        outboundHello:
            role === 'client'
                ? {
                      type: 'peer_auth_init',
                      controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                      bridgeGeneration: handoff.generation,
                      bridgeVersion: BRIDGE_VERSION,
                      instanceId: handoff.instanceId,
                      clientNonce: createPeerAuthNonce(),
                  }
                : undefined,
    });

    const rejectUnauthenticated = (state, reason) => {
        send(state.socket, {
            type: 'peer_rejected',
            reason,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        });
        closeState(state);
    };

    // Version skew and a wrong secret both end the handshake, but they are different problems for whoever reads
    // the status: skew is resolved by restarting both applications, not by investigating the token.
    //
    // The version this reads is the peer's own unverified claim, so a hostile process holding the port can make
    // the status say `protocol_mismatch` when the real answer is `authentication_failed`. That is accepted
    // deliberately: the alternative is no skew diagnostic at all, since a genuinely skewed primary fails this
    // check before any proof can be exchanged. The code steers a reader, never what is accepted, and it is not
    // evidence when a rogue local process is suspected.
    const rejectionCodeFor = (message) =>
        message?.controlProtocolVersion === CONTROL_PROTOCOL_VERSION
            ? PEER_REJECTION_CODES.authenticationFailed
            : PEER_REJECTION_CODES.protocolMismatch;

    /** @param {import('./connection-state.mjs').PeerRejectionCode} [code] */
    const rejectUntrustedPrimary = (state, code = PEER_REJECTION_CODES.authenticationFailed) => {
        connections.recordPeerRejection(code);
        closeState(state);
    };

    const completeServerHandshake = (state, peerIdentity) => {
        state.peerGeneration = peerIdentity.bridgeGeneration;
        state.peerInstanceId = peerIdentity.instanceId;
        state.peerHandshakeComplete = true;
        state.pendingPeerAuth = null;
        send(state.socket, {
            type: 'peer_welcome',
            extensionConnected: connections.extensionReady,
            browserJobSupported: connections.extensionBrowserJobReady,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
            bridgeGeneration: handoff.generation,
            bridgeVersion: BRIDGE_VERSION,
            instanceId: handoff.instanceId,
            handoffSupported: true,
        });
        return state.peerGeneration > handoff.generation
            ? {
                  type: 'handoff_requested',
                  state,
                  activeRequestCount: () => requestBroker.activeRequestCount,
                  invalidateAuthorizationWork: () => requestBroker.invalidateAuthorizationWork(),
              }
            : undefined;
    };

    const handlePeerClientMessage = async (state, message) => {
        // Every frame is honoured only from the socket that is still current — the handshake frames above all,
        // not just the operational ones below. `connectToPrimaryBridge` publishes the outbound socket before a
        // frame can arrive on it, so a mismatch means this state belongs to an attempt that has been replaced.
        // The predecessor stays readable for its whole destroy grace, and every early return below this point
        // writes to process-wide state: a late rejection would pin its verdict on the attempt now in flight,
        // and after `resetPeerAfterListen` — which nulls `peerSocket` when this process takes over the listener
        // — it would leave a healthy primary reporting a `peerRejection` it never suffered, with nothing left
        // to clear it. A null `peerSocket` therefore fails the check by design rather than skipping it.
        // Returning without closing is safe: a socket only stops being current once it is already closing.
        if (state.socket !== connections.peerSocket) return;
        if (message?.type === 'peer_rejected') {
            // Nothing in this frame is trustworthy: no proof was ever exchanged, and its `reason` is written
            // by whatever answered on loopback, so the text is never surfaced. The claimed protocol version is
            // read through the same deliberate trade-off `rejectionCodeFor` documents — this is the one frame
            // a genuinely skewed primary actually sends (it rejects the hello before any challenge), so
            // hardcoding a code here would leave version skew reported as a secret problem.
            connections.recordPeerRejection(rejectionCodeFor(message));
            closeState(state);
            return;
        }
        if (message?.type === 'peer_auth_challenge') {
            const client = state.outboundHello;
            const validChallenge =
                !state.peerHandshakeComplete &&
                !state.primaryProofVerified &&
                isValidPeerIdentity(message) &&
                isValidPeerAuthNonce(client?.clientNonce) &&
                message.clientNonce === client.clientNonce &&
                isValidPeerAuthNonce(message.serverNonce) &&
                typeof message.serverProof === 'string';
            if (!validChallenge) {
                rejectUntrustedPrimary(state, rejectionCodeFor(message));
                return;
            }
            const primary = {
                bridgeGeneration: message.bridgeGeneration,
                bridgeVersion: message.bridgeVersion,
                instanceId: message.instanceId,
                serverNonce: message.serverNonce,
            };
            const transcript = peerAuthTranscript(client, primary);
            const expectedProof = createPeerAuthProof(peerToken, 'primary', transcript);
            if (!peerTokensEqual(message.serverProof, expectedProof)) {
                rejectUntrustedPrimary(state);
                return;
            }
            state.primaryProofVerified = true;
            state.authenticatedPrimary = primary;
            state.socket.send(
                JSON.stringify({
                    type: 'peer_auth_response',
                    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                    clientProof: createPeerAuthProof(peerToken, 'client', transcript),
                })
            );
            return;
        }
        if (message?.type === 'peer_welcome') {
            const authenticatedPrimary = state.authenticatedPrimary;
            if (
                state.peerHandshakeComplete ||
                !state.primaryProofVerified ||
                message.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION ||
                message.bridgeGeneration !== authenticatedPrimary?.bridgeGeneration ||
                message.bridgeVersion !== authenticatedPrimary.bridgeVersion ||
                message.instanceId !== authenticatedPrimary.instanceId
            ) {
                rejectUntrustedPrimary(state, rejectionCodeFor(message));
                return;
            }
            state.peerHandshakeComplete = true;
            const wasReady = connections.updatePeerStatus(message, state.socket);
            // A welcome on a superseded socket publishes nothing: the readiness it would set could never be
            // cleared, because disconnectPeer only acts for the current socket.
            if (wasReady === null) return;
            handoff.markTopologySettled();
            if (!wasReady) {
                log(
                    `connected to primary local bridge generation ${message.bridgeGeneration} version ${
                        message.bridgeVersion || 'unknown'
                    }`
                );
            }
            return;
        }
        if (!state.peerHandshakeComplete) {
            connections.recordPeerRejection(PEER_REJECTION_CODES.handshakeRequired);
            closeState(state);
            return;
        }
        // What the guard at the top of this handler protects here: a frame buffered on a superseded transport
        // would otherwise park recovery behind a full listener yield, grant a takeover against a primary that
        // is still serving, or settle a broker request on behalf of a route this process no longer has.
        if (message?.type === 'peer_handoff') {
            handoff.observeHandoff(message);
            return;
        }
        if (message?.type === 'peer_handoff_cancelled') {
            handoff.observeCancellation();
            return;
        }
        if (message?.type === 'peer_takeover_granted') {
            handoff.observeTakeoverGrant(message.targetInstanceId);
            return;
        }
        if (message?.type === 'peer_status') {
            const wasReady = connections.updatePeerStatus(message, state.socket);
            if (wasReady === null) return;
            // Only a connection *becoming* ready settles the topology here. A routine broadcast on an
            // already-established socket is not a topology event: mid-handoff the draining primary keeps
            // broadcasting status to bystanders, and settling on those frames would clear the transition
            // observeHandoff just recorded.
            if (!wasReady) {
                handoff.markTopologySettled();
                const versionLabel = message.controlProtocolVersion ? `generation ${message.bridgeGeneration}` : 'legacy generation';
                log(`connected to primary local bridge ${versionLabel}`);
            }
            return;
        }
        if (message?.type === 'peer_browser_job_authorize_result' && typeof message.requestId === 'string') {
            if (message.error) requestBroker.rejectAuthorization(message.requestId, safeExternalToolError(message.error));
            else if (!requestBroker.resolveAuthorization(message.requestId, message.authorization)) {
                try {
                    state.socket.send(
                        JSON.stringify({
                            type: 'peer_browser_job_authorization_release',
                            authorizationScopeId: message.requestId,
                        })
                    );
                } catch (error) {
                    log('failed to release late peer browser-job authorization:', error.message);
                }
            }
            return;
        }
        if (message?.type !== 'peer_wb_fetch_result' || typeof message.requestId !== 'string') return;
        if (message.error) {
            // Голая строка без toolError нормализовалась в stage 'authorization' и через
            // rethrowAuthorizationError обрывала всё задание, требуя нового JWT. Отказ
            // обслуживающего процесса — это провал одной единицы исполнения.
            const peerError =
                message.toolError ??
                { code: 'PEER_REQUEST_REJECTED', message: String(message.error), stage: 'execution', retryable: false };
            requestBroker.rejectFetch(message.requestId, safeExternalToolError(peerError, 'Wildberries request failed.'));
        } else {
            requestBroker.resolveFetch(message.requestId, message.response);
        }
    };

    const handlePeerServerMessage = async (state, message) => {
        if (message?.type === 'peer_auth_init') {
            if (
                state.peerHandshakeComplete ||
                state.pendingPeerAuth ||
                !isValidPeerIdentity(message) ||
                !isValidPeerAuthNonce(message.clientNonce)
            ) {
                rejectUnauthenticated(state, 'Peer authentication failed');
                return;
            }
            const client = {
                bridgeGeneration: message.bridgeGeneration,
                bridgeVersion: message.bridgeVersion,
                instanceId: message.instanceId,
                clientNonce: message.clientNonce,
            };
            const primary = {
                bridgeGeneration: handoff.generation,
                bridgeVersion: BRIDGE_VERSION,
                instanceId: handoff.instanceId,
                serverNonce: createPeerAuthNonce(),
            };
            const transcript = peerAuthTranscript(client, primary);
            state.pendingPeerAuth = { client, transcript };
            send(state.socket, {
                type: 'peer_auth_challenge',
                controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                bridgeGeneration: primary.bridgeGeneration,
                bridgeVersion: primary.bridgeVersion,
                instanceId: primary.instanceId,
                clientNonce: client.clientNonce,
                serverNonce: primary.serverNonce,
                serverProof: createPeerAuthProof(peerToken, 'primary', transcript),
            });
            return;
        }
        if (message?.type === 'peer_auth_response') {
            const pending = state.pendingPeerAuth;
            if (
                state.peerHandshakeComplete ||
                !pending ||
                message.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION ||
                typeof message.clientProof !== 'string' ||
                !peerTokensEqual(message.clientProof, createPeerAuthProof(peerToken, 'client', pending.transcript))
            ) {
                rejectUnauthenticated(state, 'Peer authentication failed');
                return;
            }
            return completeServerHandshake(state, pending.client);
        }
        if (!state.peerHandshakeComplete) {
            rejectUnauthenticated(state, 'Peer handshake is required');
            return;
        }
        if (message?.type === 'peer_status_request') {
            send(state.socket, currentPeerStatus());
            return;
        }
        if (
            message?.type === 'peer_browser_job_authorization_release' &&
            typeof message.authorizationScopeId === 'string'
        ) {
            const authorizationLease = state.authorizationLeases.get(message.authorizationScopeId);
            if (authorizationLease) {
                state.authorizationLeases.delete(message.authorizationScopeId);
                authorizationLease.release();
            }
            return;
        }
        if (
            message?.type === 'peer_browser_job_authorize' &&
            typeof message.requestId === 'string' &&
            typeof message.token === 'string' &&
            message.token.length > 0 &&
            Buffer.byteLength(message.token, 'utf8') <= MAX_BROWSER_JOB_TOKEN_BYTES
        ) {
            try {
                for (const [authorizationScopeId, authorizationLease] of state.authorizationLeases) {
                    if (authorizationLease.isActive()) continue;
                    state.authorizationLeases.delete(authorizationScopeId);
                }
                if (state.authorizationLeases.has(message.requestId)) {
                    throw new Error('Duplicate peer browser-job authorization request');
                }
                const authorizationLease = await requestBroker.requestAuthorization(message.token);
                state.authorizationLeases.set(message.requestId, authorizationLease);
                try {
                    send(state.socket, {
                        type: 'peer_browser_job_authorize_result',
                        requestId: message.requestId,
                        authorization: authorizationLease.authorization,
                    });
                } catch (error) {
                    state.authorizationLeases.delete(message.requestId);
                    authorizationLease.release();
                    throw error;
                }
            } catch (error) {
                send(state.socket, {
                    type: 'peer_browser_job_authorize_result',
                    requestId: message.requestId,
                    error: toolFailure(error, {
                        code: 'BROWSER_JOB_AUTHORIZATION_FAILED',
                        message: 'Browser job authorization failed.',
                        stage: 'authorization',
                        retryable: false,
                    }),
                });
            }
            return;
        }
        if (
            message?.type !== 'peer_wb_fetch' ||
            typeof message.requestId !== 'string' ||
            typeof message.authorizationScopeId !== 'string' ||
            typeof message.url !== 'string' ||
            typeof message.authorizationId !== 'string' ||
            message.authorizationId.length === 0 ||
            !validTimeout(message.timeout)
        ) {
            send(state.socket, {
                type: 'peer_wb_fetch_result',
                requestId: message?.requestId,
                error: 'Invalid peer request',
            });
            return;
        }

        try {
            const authorizationLease = state.authorizationLeases.get(message.authorizationScopeId);
            if (!authorizationLease || authorizationLease.authorization?.authorizationId !== message.authorizationId) {
                throw new ToolExecutionError(
                    'BROWSER_JOB_REAUTHORIZATION_REQUIRED',
                    'Browser job authorization must be acquired again after the bridge connection changed.',
                    'authorization',
                    true
                );
            }
            const response = await authorizationLease.requestWbFetch(message.url, message.timeout);
            send(state.socket, {
                type: 'peer_wb_fetch_result',
                requestId: message.requestId,
                response,
            });
        } catch (error) {
            send(state.socket, {
                type: 'peer_wb_fetch_result',
                requestId: message.requestId,
                error: error.message,
                toolError: toolFailure(error, {
                    code: 'WB_FETCH_FAILED',
                    message: 'Wildberries request failed.',
                    stage: 'execution',
                    retryable: false,
                }),
            });
        }
    };

    const handleMessage = async (state, rawMessage) => {
        let message;
        try {
            message = JSON.parse(rawMessage);
        } catch {
            return;
        }
        return state.role === 'client'
            ? handlePeerClientMessage(state, message)
            : handlePeerServerMessage(state, message);
    };

    const onDisconnect = (state) => {
        if (state.role !== 'client') {
            handoff.abandon(state);
            for (const authorizationLease of state.authorizationLeases.values()) {
                authorizationLease.release();
            }
            state.authorizationLeases.clear();
            return { disconnected: false, shouldTakeover: false, reconnectDelay: null, rejectionCode: null };
        }
        if (!connections.disconnectPeer(state.socket)) {
            return { disconnected: false, shouldTakeover: false, reconnectDelay: null, rejectionCode: null };
        }

        const shouldTakeover = handoff.consumeTakeoverGrant();
        // A close inside an observed handoff's listener yield is read before markDisconnected below: it means
        // the primary is draining away to an instance being promoted, which is a healthy, by-design topology
        // change for this bystander too, not a failure of its connection.
        const observedHandoffClose = handoff.retryDelay(0) > 0;
        handoff.markDisconnected();
        // A socket that dropped without a protocol verdict is a plain connection failure, and a verdict already
        // reached for this attempt — an authentication rejection, say — must survive the close that follows it.
        // The close that completes a granted takeover is not a failure at all: this peer is being promoted
        // exactly as designed, and recording a rejection would surface one for a healthy handoff. The same
        // holds for a bystander whose primary hands off to a third instance.
        const classifiedFailure = !shouldTakeover && !observedHandoffClose;
        if (classifiedFailure) connections.classifyPeerCloseFailure();
        requestBroker.rejectPendingRequests(
            new ToolExecutionError(
                    'EXTENSION_DISCONNECTED',
                    'The primary local bridge disconnected before returning the WB response. Retry once it is back.',
                    'extension',
                    true
                )
        );
        requestBroker.rejectPendingAuthorizations(
            new ToolExecutionError(
                    'EXTENSION_DISCONNECTED',
                    'The primary local bridge disconnected before authorizing the browser job. Retry once it is back.',
                    'extension',
                    true
                )
        );
        const { delayMs, saturated } = connections.nextPeerReconnectDelay({
            baseMs: PEER_RECONNECT_BASE_MS,
            maxMs: PEER_RECONNECT_MAX_MS,
        });
        // Fast recovery is a genuine transition. A saturated backoff is a steady degraded state, and a flag that
        // stayed on for it would report a transition that never ends.
        if (!shouldTakeover && saturated) handoff.markTopologySettled();
        // The verdict for *this* close travels with the result instead of being re-read from
        // `connections.peerRejectionCode` by the caller: that field outlives the attempt, so a close this path
        // deliberately did not classify — a granted takeover, or a bystander watching its primary hand off —
        // would otherwise be announced under whatever code the previous streak happened to leave behind, or
        // under `null` when the streak had been reset.
        const rejectionCode = classifiedFailure ? connections.peerRejectionCode : null;
        connections.clearPeerAttemptVerdict();
        broadcastStatus();
        return { disconnected: true, shouldTakeover, reconnectDelay: delayMs, saturated, rejectionCode };
    };

    return { createState, handleMessage, onDisconnect };
};
