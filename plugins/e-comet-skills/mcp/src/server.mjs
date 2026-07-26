#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import {
    ALLOWED_EXTENSION_IDS,
    BRIDGE_GENERATION,
    BRIDGE_VERSION,
    CONTROL_PROTOCOL_VERSION,
    EXTENSION_PATH as PATH,
    EXTENSION_PROTOCOL_VERSION,
    HANDOFF_DRAIN_POLL_MS,
    HANDOFF_RECONNECT_GRACE_MS,
    HOST,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    PEER_PATH,
    PEER_RECONNECT_BASE_MS,
    PEER_RECONNECT_MAX_ATTEMPTS,
    PEER_RECONNECT_MAX_MS,
    PORT,
    RESULT_DIR,
    SESSION_NONCE,
    WS_HEARTBEAT_INTERVAL_MS,
} from './config.mjs';
import { ConnectionState } from './connection-state.mjs';
import { HandoffState } from './handoff-state.mjs';
import { createMcpMessageHandler } from './mcp-dispatcher.mjs';
import { mcpError } from './mcp-protocol.mjs';
import { loadOrCreatePeerToken, peerTokensEqual } from './peer-auth.mjs';
import { RequestBroker } from './request-broker.mjs';
import { attachStdioTransport } from './stdio-transport.mjs';
import { safeExternalToolError, toolFailure } from './tool-errors.mjs';
import { encodeFrame, parseFrames, sendWs } from './websocket.mjs';
import { validTimeout } from './wb-domain.mjs';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    console.error(`[e-comet-local-bridge] Node.js 22 or newer is required; found ${process.versions.node}`);
    process.exit(1);
}
if (!Number.isInteger(BRIDGE_GENERATION) || BRIDGE_GENERATION < 1) {
    console.error(`[e-comet-local-bridge] bridge generation must be a positive integer; found ${BRIDGE_GENERATION}`);
    process.exit(1);
}

const log = (...args) => console.error('[e-comet-local-bridge]', ...args);
const loadPeerTokenOrExit = async () => {
    try {
        return await loadOrCreatePeerToken();
    } catch (error) {
        log('failed to initialize local peer authentication:', error.message);
        process.exit(1);
    }
};

const INSTANCE_ID = randomUUID();
const PEER_TOKEN = await loadPeerTokenOrExit();
const connections = new ConnectionState();
const handoff = new HandoffState({
    generation: BRIDGE_GENERATION,
    instanceId: INSTANCE_ID,
    reconnectGraceMs: HANDOFF_RECONNECT_GRACE_MS,
});
const peerStates = new Set();

const effectiveExtensionReady = () => connections.effectiveExtensionReady;
const effectiveBrowserJobReady = () => connections.effectiveBrowserJobReady;

const finishBridgeTransitionIfRoutable = () => {
    handoff.markRoutable(effectiveExtensionReady());
};

const peerStatusMessage = () => ({
    type: 'peer_status',
    extensionConnected: connections.extensionReady,
    browserJobSupported: connections.extensionBrowserJobReady,
    bridgeTransitioning: handoff.transitioning,
    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
    extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
    bridgeGeneration: BRIDGE_GENERATION,
    bridgeVersion: BRIDGE_VERSION,
    instanceId: INSTANCE_ID,
});

const broadcastPeerStatus = () => {
    const message = peerStatusMessage();
    for (const state of peerStates) {
        try {
            sendWs(state.socket, message);
        } catch {
            peerStates.delete(state);
        }
    }
};

const localMessage = (id, type, payload) => ({ id, type, payload });

const isAllowedExtensionOrigin = (origin) => {
    if (!origin.startsWith('chrome-extension://')) {
        return false;
    }
    if (ALLOWED_EXTENSION_IDS.size === 0) {
        return true;
    }
    return ALLOWED_EXTENSION_IDS.has(origin.slice('chrome-extension://'.length));
};

const handleExtensionMessage = async (state, rawMessage) => {
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
    if (!isMessage) {
        return;
    }
    const type = message.type;
    const payload = message.payload;

    if (type === 'hello_ack') {
        if (message.id !== state.helloId || payload.sessionNonce !== SESSION_NONCE) {
            log('rejected extension hello_ack with an invalid session nonce');
            socket.end(encodeFrame('', 0x8));
            return;
        }
        if (payload.protocolVersion !== undefined && payload.protocolVersion !== EXTENSION_PROTOCOL_VERSION) {
            log(`rejected extension protocol ${payload.protocolVersion}; expected ${EXTENSION_PROTOCOL_VERSION}`);
            socket.end(encodeFrame('', 0x8));
            return;
        }
        const previousSocket = connections.connectExtension(
            socket,
            Array.isArray(payload.capabilities) && payload.capabilities.includes('browser_job')
        );
        previousSocket?.end(encodeFrame('', 0x8));
        finishBridgeTransitionIfRoutable();
        log(`extension connected, version ${payload.extensionVersion || 'unknown'}`);
        broadcastPeerStatus();
        return;
    }

    if (type === 'ping') {
        sendWs(socket, localMessage(message.id, 'pong', { at: Date.now() }));
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

    if (type !== 'wb_fetch_result') {
        return;
    }

    requestBroker.resolveFetch(message.id, payload.response, { includeRequestId: true });
};

const server = createServer((request, response) => {
    if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, extensionConnected: connections.extensionReady }));
        return;
    }
    response.writeHead(404);
    response.end();
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const sendPeerControl = (state, message) => {
    try {
        sendWs(state.socket, message);
        return true;
    } catch {
        return false;
    }
};

const relinquishBridge = () => {
    handoff.deferListener();
    const currentExtensionSocket = connections.extensionSocket;
    connections.disconnectExtension(currentExtensionSocket);

    server.close(() => {
        clearTimeout(connections.peerReconnectTimer);
        connections.peerReconnectTimer = setTimeout(connectToPrimaryBridge, 250);
    });

    if (currentExtensionSocket) {
        currentExtensionSocket.end(encodeFrame('', 0x8));
    }
    for (const state of [...peerStates]) {
        state.socket.end(encodeFrame('', 0x8));
    }
    setTimeout(() => {
        currentExtensionSocket?.destroy();
        for (const state of [...peerStates]) {
            state.socket.destroy();
        }
    }, 100);
};

const beginHandoff = async (targetState) => {
    if (!handoff.begin(targetState)) return;
    const notice = {
        type: 'peer_handoff',
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        targetInstanceId: targetState.peerInstanceId,
        targetGeneration: targetState.peerGeneration,
        reconnectGraceMs: HANDOFF_RECONNECT_GRACE_MS,
    };
    for (const state of peerStates) {
        sendPeerControl(state, notice);
    }
    log(
        `handoff requested by generation ${targetState.peerGeneration} instance ${targetState.peerInstanceId}; ` +
            `draining ${requestBroker.activeRequestCount} active request(s)`
    );

    while (requestBroker.activeRequestCount > 0 && handoff.isTarget(targetState) && !targetState.socket.destroyed) {
        await delay(HANDOFF_DRAIN_POLL_MS);
    }
    if (!handoff.isTarget(targetState) || targetState.socket.destroyed) {
        handoff.cancel(targetState);
        for (const state of peerStates) {
            sendPeerControl(state, {
                type: 'peer_handoff_cancelled',
                controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            });
        }
        return;
    }

    const granted = sendPeerControl(targetState, {
        type: 'peer_takeover_granted',
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        targetInstanceId: targetState.peerInstanceId,
        targetGeneration: targetState.peerGeneration,
    });
    if (!granted) {
        handoff.abandon(targetState);
        return;
    }
    log(`handoff granted to generation ${targetState.peerGeneration} instance ${targetState.peerInstanceId}`);
    await delay(HANDOFF_DRAIN_POLL_MS);
    relinquishBridge();
};

const handlePeerMessage = async (state, rawMessage) => {
    let message;
    try {
        message = JSON.parse(rawMessage);
    } catch {
        return;
    }
    if (message?.type === 'peer_hello') {
        if (
            state.peerHandshakeComplete ||
            message.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION ||
            !Number.isInteger(message.bridgeGeneration) ||
            message.bridgeGeneration < 1 ||
            typeof message.instanceId !== 'string' ||
            message.instanceId.length === 0 ||
            !peerTokensEqual(message.authToken, PEER_TOKEN)
        ) {
            sendPeerControl(state, {
                type: 'peer_rejected',
                reason: 'Peer authentication failed',
                controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            });
            state.socket.end(encodeFrame('', 0x8));
            return;
        }
        state.peerGeneration = message.bridgeGeneration;
        state.peerInstanceId = message.instanceId;
        state.peerHandshakeComplete = true;
        sendPeerControl(state, {
            type: 'peer_welcome',
            extensionConnected: connections.extensionReady,
            browserJobSupported: connections.extensionBrowserJobReady,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
            bridgeGeneration: BRIDGE_GENERATION,
            bridgeVersion: BRIDGE_VERSION,
            instanceId: INSTANCE_ID,
            handoffSupported: true,
        });
        if (state.peerGeneration > BRIDGE_GENERATION) {
            void beginHandoff(state).catch((error) => log('handoff failed:', error.message));
        }
        return;
    }
    if (!state.peerHandshakeComplete) {
        sendPeerControl(state, {
            type: 'peer_rejected',
            reason: 'Peer handshake is required',
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        });
        state.socket.end(encodeFrame('', 0x8));
        return;
    }
    if (message?.type === 'peer_status_request') {
        sendWs(state.socket, peerStatusMessage());
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
            const authorization = await requestBrowserJobAuthorization(message.token);
            sendWs(state.socket, {
                type: 'peer_browser_job_authorize_result',
                requestId: message.requestId,
                authorization,
            });
        } catch (error) {
            sendWs(state.socket, {
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
        typeof message.url !== 'string' ||
        typeof message.authorizationId !== 'string' ||
        message.authorizationId.length === 0 ||
        !validTimeout(message.timeout)
    ) {
        sendWs(state.socket, {
            type: 'peer_wb_fetch_result',
            requestId: message?.requestId,
            error: 'Invalid peer request',
        });
        return;
    }
    try {
        const response = await requestWbFetch(message.url, message.timeout, message.authorizationId);
        sendWs(state.socket, {
            type: 'peer_wb_fetch_result',
            requestId: message.requestId,
            response,
        });
    } catch (error) {
        sendWs(state.socket, {
            type: 'peer_wb_fetch_result',
            requestId: message.requestId,
            error: error.message,
        });
    }
};

server.on('upgrade', (request, socket) => {
    if (
        (request.url !== PATH && request.url !== PEER_PATH) ||
        request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !request.headers['sec-websocket-key']
    ) {
        socket.destroy();
        return;
    }

    const origin = request.headers.origin || process.env.ECOMET_LOCAL_BRIDGE_TEST_ORIGIN || '';
    if ((request.url === PATH && !isAllowedExtensionOrigin(origin)) || (origin && !origin.startsWith('chrome-extension://'))) {
        log(`rejected WebSocket origin ${origin}`);
        socket.destroy();
        return;
    }

    const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');

    socket.write(
        ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join(
            '\r\n'
        )
    );
    const state = {
        buffer: Buffer.alloc(0),
        socket,
        path: request.url,
        origin,
        fragmentOpcode: null,
        fragments: [],
        fragmentBytes: 0,
        awaitingPong: false,
        heartbeatTimer: null,
    };
    const close = () => {
        clearInterval(state.heartbeatTimer);
        peerStates.delete(state);
        handoff.abandon(state);
        if (connections.disconnectExtension(socket)) {
            requestBroker.rejectPendingRequests('Extension disconnected before returning the WB response');
            requestBroker.rejectPendingAuthorizations('Extension disconnected before authorizing the browser job');
            log('extension disconnected');
            broadcastPeerStatus();
        }
        socket.destroy();
    };

    if (request.url === PEER_PATH) {
        peerStates.add(state);
    }

    if (request.url === PATH) {
        state.helloId = randomUUID();
        sendWs(
            socket,
            localMessage(state.helloId, 'hello', {
                clientName: 'e-comet-local-bridge',
                clientVersion: BRIDGE_VERSION,
                protocolVersion: EXTENSION_PROTOCOL_VERSION,
                bridgeGeneration: BRIDGE_GENERATION,
                sessionNonce: SESSION_NONCE,
            })
        );
    }

    state.heartbeatTimer = setInterval(() => {
        if (socket.destroyed || !socket.writable) {
            close();
            return;
        }
        if (state.awaitingPong) {
            log(`closing unresponsive WebSocket client on ${state.path}`);
            close();
            return;
        }
        state.awaitingPong = true;
        socket.write(encodeFrame('', 0x9));
    }, WS_HEARTBEAT_INTERVAL_MS);
    state.heartbeatTimer.unref();

    socket.on('data', (chunk) => {
        try {
            parseFrames(
                state,
                chunk,
                (message) => void (state.path === PEER_PATH ? handlePeerMessage(state, message) : handleExtensionMessage(state, message)),
                close
            );
        } catch (error) {
            log('WebSocket protocol error:', error.message);
            close();
        }
    });
    socket.on('close', close);
    socket.on('error', close);
});

const waitForBridgeTransition = async (timeout) => {
    if (!handoff.transitioning) return;
    const deadline = Date.now() + Math.min(timeout, 10000);
    while (handoff.transitioning) {
        if (Date.now() >= deadline) {
            throw new Error('Local bridge upgrade did not complete before the request timeout');
        }
        await delay(HANDOFF_DRAIN_POLL_MS);
    }
};

const requestBroker = new RequestBroker({
    waitForTransition: waitForBridgeTransition,
    routeWbFetch: ({ requestId, url, timeout, authorizationId }) => {
        if (connections.extensionReady) {
            sendWs(connections.extensionSocket, localMessage(requestId, 'wb_fetch', { url, timeout, authorizationId }));
        } else if (connections.peerReady && connections.peerSocket?.readyState === WebSocket.OPEN) {
            connections.peerSocket.send(JSON.stringify({ type: 'peer_wb_fetch', requestId, url, timeout, authorizationId }));
        } else {
            throw new Error('The e-Comet Chrome extension is not connected');
        }
    },
    routeAuthorization: ({ requestId, token }) => {
        if (connections.extensionReady && !connections.extensionBrowserJobReady) {
            throw new Error('The e-Comet Chrome extension must be updated to support signed browser jobs');
        }
        if (connections.extensionBrowserJobReady) {
            sendWs(connections.extensionSocket, localMessage(requestId, 'browser_job_authorize', { token }));
        } else if (connections.peerReady && !connections.peerExtensionBrowserJobReady) {
            throw new Error('The e-Comet Chrome extension must be updated to support signed browser jobs');
        } else if (connections.peerExtensionBrowserJobReady && connections.peerSocket?.readyState === WebSocket.OPEN) {
            connections.peerSocket.send(JSON.stringify({ type: 'peer_browser_job_authorize', requestId, token }));
        } else {
            throw new Error('The e-Comet Chrome extension is not connected');
        }
    },
});
const requestWbFetch = (...args) => requestBroker.requestWbFetch(...args);
const requestBrowserJobAuthorization = (...args) => requestBroker.requestAuthorization(...args);


const connectToPrimaryBridge = () => {
    if (connections.peerSocket && (connections.peerSocket.readyState === WebSocket.OPEN || connections.peerSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }
    const socket = new WebSocket(`ws://${HOST}:${PORT}${PEER_PATH}`);
    connections.peerSocket = socket;
    socket.addEventListener('open', () => {
        socket.send(
            JSON.stringify({
                type: 'peer_hello',
                controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                bridgeGeneration: BRIDGE_GENERATION,
                bridgeVersion: BRIDGE_VERSION,
                instanceId: INSTANCE_ID,
                authToken: PEER_TOKEN,
            })
        );
    });
    socket.addEventListener('message', (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (message?.type === 'peer_handoff') {
            handoff.observeHandoff(message);
            return;
        }
        if (message?.type === 'peer_handoff_cancelled') {
            handoff.observeCancellation();
            return;
        }
        if (message?.type === 'peer_takeover_granted' && handoff.observeTakeoverGrant(message.targetInstanceId)) {
            return;
        }
        if (message?.type === 'peer_rejected') {
            connections.recordPeerRejection(message.reason);
            socket.close();
            return;
        }
        if (message?.type === 'peer_welcome') {
            if (message.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION) {
                log(`primary uses unsupported peer control protocol ${message.controlProtocolVersion}`);
                socket.close();
                return;
            }
            const wasReady = connections.updatePeerStatus(message);
            finishBridgeTransitionIfRoutable();
            if (!wasReady) {
                log(
                    `connected to primary local bridge generation ${message.bridgeGeneration} version ${
                        message.bridgeVersion || 'unknown'
                    } ` + `at ${HOST}:${PORT}`
                );
            }
            return;
        }
        if (message?.type === 'peer_status') {
            const wasReady = connections.updatePeerStatus(message);
            finishBridgeTransitionIfRoutable();
            if (!wasReady) {
                const versionLabel = message.controlProtocolVersion ? `generation ${message.bridgeGeneration}` : 'legacy generation';
                log(`connected to primary local bridge ${versionLabel} at ${HOST}:${PORT}`);
            }
            return;
        }
        if (message?.type === 'peer_browser_job_authorize_result' && typeof message.requestId === 'string') {
            if (message.error) requestBroker.rejectAuthorization(message.requestId, safeExternalToolError(message.error));
            else requestBroker.resolveAuthorization(message.requestId, message.authorization);
            return;
        }
        if (message?.type !== 'peer_wb_fetch_result' || typeof message.requestId !== 'string') return;
        if (message.error) requestBroker.rejectFetch(message.requestId, message.error);
        else requestBroker.resolveFetch(message.requestId, message.response);
    });
    const disconnected = () => {
        if (!connections.disconnectPeer(socket)) return;
        const shouldTakeover = handoff.consumeTakeoverGrant();
        handoff.markDisconnected();
        requestBroker.rejectPendingRequests('Primary local bridge disconnected before returning the WB response');
        requestBroker.rejectPendingAuthorizations('Primary local bridge disconnected before authorizing the browser job');
        clearTimeout(connections.peerReconnectTimer);
        const reconnectDelay = connections.nextPeerReconnectDelay({
            baseMs: PEER_RECONNECT_BASE_MS,
            maxMs: PEER_RECONNECT_MAX_MS,
            maxAttempts: PEER_RECONNECT_MAX_ATTEMPTS,
        });
        if (!shouldTakeover && reconnectDelay === null) {
            handoff.observeCancellation();
            log(
                `stopped reconnecting to the primary local bridge after ${PEER_RECONNECT_MAX_ATTEMPTS} attempts: ${
                    connections.peerRejectionReason || 'connection failed'
                }`
            );
            return;
        }
        const retryDelay = shouldTakeover ? HANDOFF_DRAIN_POLL_MS : Math.max(reconnectDelay, handoff.retryDelay());
        connections.peerReconnectTimer = setTimeout(startBridgeListener, retryDelay);
    };
    socket.addEventListener('close', disconnected, { once: true });
    socket.addEventListener('error', () => socket.close(), { once: true });
};

const handleMcpMessage = createMcpMessageHandler({
    getBridgeStatus: () => ({
        extensionConnected: effectiveExtensionReady(),
        browserJobSupported: effectiveBrowserJobReady(),
        bridgeRole: server.listening ? 'primary' : connections.peerReady ? 'secondary' : 'disconnected',
        bridgeTransitioning: handoff.transitioning,
        bridgeVersion: BRIDGE_VERSION,
        bridgeGeneration: BRIDGE_GENERATION,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
        instanceId: INSTANCE_ID,
        websocket: `ws://${HOST}:${PORT}${PATH}`,
        resultDirectory: RESULT_DIR,
    }),
    isExtensionReady: effectiveExtensionReady,
    requestBrowserJobAuthorization,
    requestWbFetch,
});

attachStdioTransport({ handleMessage: handleMcpMessage, sendError: mcpError });

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        if (connections.peerReconnectAttempts === 0) {
            log(`local bridge already exists at ${HOST}:${PORT}; using it as the primary instance`);
        }
        connectToPrimaryBridge();
        return;
    }
    log(`failed to listen on ${HOST}:${PORT}:`, error.message);
    process.exitCode = 1;
});

const startBridgeListener = () => {
    if (server.listening) return;
    try {
        server.listen(PORT, HOST, () => {
            connections.resetPeerAfterListen();
            handoff.resetAfterListen();
            log(`listening on ws://${HOST}:${PORT}${PATH} as generation ${BRIDGE_GENERATION} version ${BRIDGE_VERSION}`);
        });
    } catch (error) {
        log('failed to start local bridge listener:', error.message);
    }
};

startBridgeListener();
