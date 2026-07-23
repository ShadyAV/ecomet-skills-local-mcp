#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import {
    ALLOWED_EXTENSION_IDS,
    BRIDGE_GENERATION,
    BRIDGE_VERSION,
    CONTROL_PROTOCOL_VERSION,
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
    EXTENSION_CONNECT_GRACE_MS,
    EXTENSION_PATH as PATH,
    EXTENSION_PROTOCOL_VERSION,
    HANDOFF_DRAIN_POLL_MS,
    HANDOFF_RECONNECT_GRACE_MS,
    HOST,
    IMAGE_BASKET_BOUNDS,
    IMAGE_CONCURRENCY,
    MAX_IMAGE_ARTICLES,
    MAX_IMAGE_BASKET,
    MAX_IMAGE_PHOTOS,
    MAX_MCP_MESSAGE_BYTES,
    MAX_PRODUCT_ARTICLES,
    MAX_RECOMMENDATION_ARTICLES,
    MAX_RECOMMENDATION_PAGES,
    MAX_REQUEST_TIMEOUT_MS,
    MAX_RETURNED_PRODUCTS,
    MAX_SEARCH_PAGES,
    MAX_SEARCH_QUERIES,
    MIN_REQUEST_TIMEOUT_MS,
    PEER_PATH,
    PORT,
    PRODUCT_CARD_CONCURRENCY,
    RECOMMENDATION_CONCURRENCY,
    REQUEST_TIMEOUT_MS,
    RESULT_DIR,
    SEARCH_CONCURRENCY,
    SESSION_NONCE,
} from './config.mjs';
import { createJobWriter, saveResult, summarizeBody } from './result-store.mjs';
import { executeAuthorizedBrowserJob, extractBrowserJobToken } from './browser-job.mjs';
import { mcpError, mcpResult, textResult } from './mcp-protocol.mjs';
import { tools } from './tool-catalog.mjs';
import { encodeFrame, parseFrames, sendWs } from './websocket.mjs';
import {
    buildRecommendationUrls,
    buildSearchUrls,
    discoverImageBasket,
    imageExists,
    isSuccessfulWbResponse,
    normalizeStatus,
    numberOrUndefined,
    productDetailUrl,
    projectPageProducts,
    recommendationTotalPages,
    requestWbFetchWithFallback,
    responseProducts,
    runWithConcurrency,
    summarizeProduct,
    validProductProjection,
    validTimeout,
} from './wb-domain.mjs';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    console.error(`[e-comet-local-bridge] Node.js 22 or newer is required; found ${process.versions.node}`);
    process.exit(1);
}
if (!Number.isInteger(BRIDGE_GENERATION) || BRIDGE_GENERATION < 1) {
    console.error(`[e-comet-local-bridge] bridge generation must be a positive integer; found ${BRIDGE_GENERATION}`);
    process.exit(1);
}

const INSTANCE_ID = randomUUID();
let extensionSocket = null;
let extensionReady = false;
let extensionBrowserJobReady = false;
let peerSocket = null;
let peerReady = false;
let peerExtensionReady = false;
let peerExtensionBrowserJobReady = false;
let peerReconnectTimer = null;
let takeoverGranted = false;
let listenerYieldUntil = 0;
let handoffTarget = null;
let bridgeTransitioning = false;
const peerStates = new Set();
const pendingRequests = new Map();
const pendingAuthorizations = new Map();
const inFlightFetches = new Map();

const log = (...args) => console.error('[e-comet-local-bridge]', ...args);

const isAllowedWbUrl = (value) => {
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || (hostname !== 'wildberries.ru' && hostname !== 'www.wildberries.ru')) {
            return false;
        }
        return /^\/__internal\/(card|u-card|search|u-search|recom|u-recom|recommendations)\//.test(url.pathname);
    } catch {
        return false;
    }
};

const rejectPendingRequests = (message) => {
    for (const [requestId, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
        pendingRequests.delete(requestId);
    }
};

const rejectPendingAuthorizations = (message) => {
    for (const [requestId, pending] of pendingAuthorizations) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
        pendingAuthorizations.delete(requestId);
    }
};

const effectiveExtensionReady = () => extensionReady || (peerReady && peerExtensionReady);
const effectiveBrowserJobReady = () => extensionBrowserJobReady || (peerReady && peerExtensionBrowserJobReady);

const finishBridgeTransitionIfRoutable = () => {
    if (effectiveExtensionReady()) {
        bridgeTransitioning = false;
    }
};

const peerStatusMessage = () => ({
    type: 'peer_status',
    extensionConnected: extensionReady,
    browserJobSupported: extensionBrowserJobReady,
    bridgeTransitioning,
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
        if (extensionSocket && extensionSocket !== socket) {
            extensionSocket.end(encodeFrame('', 0x8));
        }
        extensionSocket = socket;
        extensionReady = true;
        extensionBrowserJobReady = Array.isArray(payload.capabilities) && payload.capabilities.includes('browser_job');
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
        const pending = pendingAuthorizations.get(message.id);
        if (!pending) {
            return;
        }
        pendingAuthorizations.delete(message.id);
        clearTimeout(pending.timer);
        if (payload.error) {
            pending.reject(new Error(payload.error.message || 'Browser job authorization failed'));
        } else {
            pending.resolve(payload.authorization);
        }
        return;
    }

    if (type !== 'wb_fetch_result') {
        return;
    }

    const pending = pendingRequests.get(message.id);
    if (!pending) {
        return;
    }
    pendingRequests.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve({ ...payload.response, requestId: message.id });
};

const server = createServer((request, response) => {
    if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, extensionConnected: extensionReady }));
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
    listenerYieldUntil = Date.now() + HANDOFF_RECONNECT_GRACE_MS;
    const currentExtensionSocket = extensionSocket;
    extensionSocket = null;
    extensionReady = false;
    extensionBrowserJobReady = false;

    server.close(() => {
        clearTimeout(peerReconnectTimer);
        peerReconnectTimer = setTimeout(connectToPrimaryBridge, 250);
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
    if (handoffTarget || targetState.peerGeneration <= BRIDGE_GENERATION) {
        return;
    }
    handoffTarget = targetState;
    bridgeTransitioning = true;
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
            `draining ${pendingRequests.size} active request(s)`
    );

    while (pendingRequests.size > 0 && handoffTarget === targetState && !targetState.socket.destroyed) {
        await delay(HANDOFF_DRAIN_POLL_MS);
    }
    if (handoffTarget !== targetState || targetState.socket.destroyed) {
        handoffTarget = null;
        bridgeTransitioning = false;
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
        handoffTarget = null;
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
            message.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION ||
            !Number.isInteger(message.bridgeGeneration) ||
            message.bridgeGeneration < 1 ||
            typeof message.instanceId !== 'string' ||
            message.instanceId.length === 0
        ) {
            sendPeerControl(state, {
                type: 'peer_rejected',
                reason: 'Unsupported peer control protocol',
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
            extensionConnected: extensionReady,
            browserJobSupported: extensionBrowserJobReady,
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
    if (message?.type === 'peer_status_request') {
        sendWs(state.socket, peerStatusMessage());
        return;
    }
    if (
        message?.type === 'peer_browser_job_authorize' &&
        typeof message.requestId === 'string' &&
        typeof message.token === 'string' &&
        message.token.length > 0 &&
        message.token.length <= 128 * 1024
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
                error: error.message,
            });
        }
        return;
    }
    if (
        message?.type !== 'peer_wb_fetch' ||
        typeof message.requestId !== 'string' ||
        typeof message.url !== 'string' ||
        (message.authorizationId === undefined && !isAllowedWbUrl(message.url)) ||
        (message.authorizationId !== undefined && typeof message.authorizationId !== 'string') ||
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
    };
    const close = () => {
        peerStates.delete(state);
        if (handoffTarget === state) {
            handoffTarget = null;
        }
        if (extensionSocket === socket) {
            extensionSocket = null;
            extensionReady = false;
            extensionBrowserJobReady = false;
            rejectPendingRequests('Extension disconnected before returning the WB response');
            rejectPendingAuthorizations('Extension disconnected before authorizing the browser job');
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
    if (!bridgeTransitioning) return;
    const deadline = Date.now() + Math.min(timeout, 10000);
    while (bridgeTransitioning) {
        if (Date.now() >= deadline) {
            throw new Error('Local bridge upgrade did not complete before the request timeout');
        }
        await delay(HANDOFF_DRAIN_POLL_MS);
    }
};

const waitForExtensionReady = async (graceMs = EXTENSION_CONNECT_GRACE_MS) => {
    const deadline = Date.now() + graceMs;
    while (!effectiveExtensionReady()) {
        if (Date.now() >= deadline) {
            return false;
        }
        await delay(HANDOFF_DRAIN_POLL_MS);
    }
    return true;
};

const requestWbFetch =(url, timeout = REQUEST_TIMEOUT_MS, authorizationId) => {
    const dedupeKey = `${authorizationId || ''}\n${url}\n${timeout}`;
    const existing = inFlightFetches.get(dedupeKey);
    if (existing) {
        return existing;
    }

    const request = (async () => {
        await waitForBridgeTransition(timeout);
        return new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const timer = setTimeout(() => {
                pendingRequests.delete(requestId);
                reject(new Error(`WB request timed out after ${timeout} ms`));
            }, timeout);

            pendingRequests.set(requestId, { resolve, reject, timer });
            try {
                if (extensionReady) {
                    sendWs(
                        extensionSocket,
                        localMessage(requestId, 'wb_fetch', {
                            url,
                            timeout,
                            ...(authorizationId ? { authorizationId } : {}),
                        })
                    );
                } else if (peerReady && peerSocket?.readyState === WebSocket.OPEN) {
                    peerSocket.send(
                        JSON.stringify({
                            type: 'peer_wb_fetch',
                            requestId,
                            url,
                            timeout,
                            authorizationId,
                        })
                    );
                } else {
                    throw new Error('The e-Comet Chrome extension is not connected');
                }
            } catch (error) {
                clearTimeout(timer);
                pendingRequests.delete(requestId);
                reject(error);
            }
        });
    })();
    inFlightFetches.set(dedupeKey, request);
    void request.then(
        () => inFlightFetches.delete(dedupeKey),
        () => inFlightFetches.delete(dedupeKey)
    );
    return request;
};

const requestBrowserJobAuthorization = (token, timeout = REQUEST_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
            pendingAuthorizations.delete(requestId);
            reject(new Error(`Browser job authorization timed out after ${timeout} ms`));
        }, timeout);
        pendingAuthorizations.set(requestId, { resolve, reject, timer });
        try {
            if (extensionReady && !extensionBrowserJobReady) {
                throw new Error('The e-Comet Chrome extension must be updated to support signed browser jobs');
            }
            if (extensionBrowserJobReady) {
                sendWs(extensionSocket, localMessage(requestId, 'browser_job_authorize', { token }));
            } else if (peerReady && !peerExtensionBrowserJobReady) {
                throw new Error('The e-Comet Chrome extension must be updated to support signed browser jobs');
            } else if (peerExtensionBrowserJobReady && peerSocket?.readyState === WebSocket.OPEN) {
                peerSocket.send(
                    JSON.stringify({
                        type: 'peer_browser_job_authorize',
                        requestId,
                        token,
                    })
                );
            } else {
                throw new Error('The e-Comet Chrome extension is not connected');
            }
        } catch (error) {
            clearTimeout(timer);
            pendingAuthorizations.delete(requestId);
            reject(error);
        }
    });

const connectToPrimaryBridge = () => {
    if (peerSocket && (peerSocket.readyState === WebSocket.OPEN || peerSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }
    const socket = new WebSocket(`ws://${HOST}:${PORT}${PEER_PATH}`);
    peerSocket = socket;
    socket.addEventListener('open', () => {
        socket.send(
            JSON.stringify({
                type: 'peer_hello',
                controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                bridgeGeneration: BRIDGE_GENERATION,
                bridgeVersion: BRIDGE_VERSION,
                instanceId: INSTANCE_ID,
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
            bridgeTransitioning = true;
            if (message.targetInstanceId !== INSTANCE_ID) {
                listenerYieldUntil = Math.max(
                    listenerYieldUntil,
                    Date.now() + (Number(message.reconnectGraceMs) || HANDOFF_RECONNECT_GRACE_MS)
                );
            }
            return;
        }
        if (message?.type === 'peer_handoff_cancelled') {
            bridgeTransitioning = false;
            return;
        }
        if (message?.type === 'peer_takeover_granted' && message.targetInstanceId === INSTANCE_ID) {
            takeoverGranted = true;
            return;
        }
        if (message?.type === 'peer_rejected') {
            log(`primary rejected peer handshake: ${message.reason || 'unknown reason'}`);
            socket.close();
            return;
        }
        if (message?.type === 'peer_welcome') {
            if (message.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION) {
                log(`primary uses unsupported peer control protocol ${message.controlProtocolVersion}`);
                socket.close();
                return;
            }
            const wasReady = peerReady;
            peerReady = true;
            peerExtensionReady = message.extensionConnected === true;
            peerExtensionBrowserJobReady = message.browserJobSupported === true;
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
            const wasReady = peerReady;
            peerReady = true;
            peerExtensionReady = message.extensionConnected === true;
            peerExtensionBrowserJobReady = message.browserJobSupported === true;
            finishBridgeTransitionIfRoutable();
            if (!wasReady) {
                const versionLabel = message.controlProtocolVersion ? `generation ${message.bridgeGeneration}` : 'legacy generation';
                log(`connected to primary local bridge ${versionLabel} at ${HOST}:${PORT}`);
            }
            return;
        }
        if (message?.type === 'peer_browser_job_authorize_result' && typeof message.requestId === 'string') {
            const pending = pendingAuthorizations.get(message.requestId);
            if (!pending) return;
            pendingAuthorizations.delete(message.requestId);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.authorization);
            return;
        }
        if (message?.type !== 'peer_wb_fetch_result' || typeof message.requestId !== 'string') return;
        const pending = pendingRequests.get(message.requestId);
        if (!pending) return;
        pendingRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.response);
    });
    const disconnected = () => {
        if (peerSocket !== socket) return;
        const shouldTakeover = takeoverGranted;
        takeoverGranted = false;
        peerSocket = null;
        peerReady = false;
        peerExtensionReady = false;
        peerExtensionBrowserJobReady = false;
        bridgeTransitioning = true;
        rejectPendingRequests('Primary local bridge disconnected before returning the WB response');
        rejectPendingAuthorizations('Primary local bridge disconnected before authorizing the browser job');
        clearTimeout(peerReconnectTimer);
        const retryDelay = shouldTakeover ? HANDOFF_DRAIN_POLL_MS : Math.max(500, listenerYieldUntil - Date.now());
        peerReconnectTimer = setTimeout(startBridgeListener, retryDelay);
    };
    socket.addEventListener('close', disconnected, { once: true });
    socket.addEventListener('error', () => socket.close(), { once: true });
};

const handleMcpMessage = async (message) => {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        if (message?.id !== undefined) mcpError(message.id, -32600, 'Invalid Request');
        return;
    }

    const { id, method, params } = message;
    if (method === 'notifications/initialized' || id === undefined) {
        return;
    }

    if (method === 'initialize') {
        mcpResult(id, {
            protocolVersion: params?.protocolVersion || '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'e-comet-local-bridge', version: BRIDGE_VERSION },
            instructions: [
                'e-Comet local bridge for signed Wildberries browser jobs.',
                'The remote e-comet MCP server (tool browser_job) connects asynchronously via OAuth: during roughly the first 30 seconds of a session it may look "still connecting" or "requires authentication" even though the user is already authorized.',
                'Never tell the user authorization is missing based on that initial state. Instead re-run tool discovery after a few seconds, up to 3 attempts, and only report an authorization problem if browser_job is still unavailable after the retries.',
                'The e-Comet Chrome extension reconnects to this bridge with backoff; local tools already wait up to 15 seconds for it. If a tool still returns "extension is not connected" right after session start, retry the call once before asking the user to open Chrome.',
            ].join('\n'),
        });
        return;
    }
    if (method === 'ping') {
        mcpResult(id, {});
        return;
    }
    if (method === 'tools/list') {
        mcpResult(id, { tools });
        return;
    }
    if (method !== 'tools/call') {
        mcpError(id, -32601, `Method not found: ${method}`);
        return;
    }

    if (params?.name === 'local_bridge_status') {
        mcpResult(
            id,
            textResult({
                ok: true,
                extensionConnected: effectiveExtensionReady(),
                browserJobSupported: effectiveBrowserJobReady(),
                bridgeRole: server.listening ? 'primary' : peerReady ? 'secondary' : 'disconnected',
                bridgeTransitioning,
                bridgeVersion: BRIDGE_VERSION,
                bridgeGeneration: BRIDGE_GENERATION,
                controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
                extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
                instanceId: INSTANCE_ID,
                websocket: `ws://${HOST}:${PORT}${PATH}`,
                resultDirectory: RESULT_DIR,
            })
        );
        return;
    }

    if (params?.name === 'execute_browser_job') {
        const triggerUrl = params.arguments?.triggerUrl;
        const productLimitTotal = params.arguments?.productLimitTotal ?? DEFAULT_RETURNED_PRODUCTS;
        const productNmIds = params.arguments?.productNmIds;
        if (
            typeof triggerUrl !== 'string' ||
            triggerUrl.length === 0 ||
            triggerUrl.length > 128 * 1024 ||
            !validProductProjection(productLimitTotal, productNmIds)
        ) {
            mcpResult(id, textResult({ ok: false, error: 'Invalid execute_browser_job arguments' }, true));
            return;
        }
        if (!(await waitForExtensionReady())) {
            mcpResult(id, textResult({ ok: false, error: 'The e-Comet Chrome extension is not connected' }, true));
            return;
        }

        let writer;
        try {
            const token = extractBrowserJobToken(triggerUrl);
            const authorization = await requestBrowserJobAuthorization(token);
            if (
                !authorization ||
                typeof authorization.authorizationId !== 'string' ||
                typeof authorization.jobType !== 'string' ||
                !authorization.job ||
                typeof authorization.job !== 'object'
            ) {
                throw new Error('Extension returned an invalid browser job authorization');
            }
            writer = await createJobWriter(authorization.job.jobId);
            const result = await executeAuthorizedBrowserJob({
                authorization,
                requestWbFetch,
                writer,
                productLimitTotal,
                productNmIds,
            });
            await writer.close();
            mcpResult(id, textResult({ ...result, resultPath: writer.resultPath }, !result.ok));
        } catch (error) {
            if (writer) {
                await writer.close().catch(() => undefined);
            }
            mcpResult(id, textResult({ ok: false, error: error.message }, true));
        }
        return;
    }

    if (params?.name === 'wb_search_by_query') {
        const rawQueries = params.arguments?.queries;
        const timeout = params.arguments?.timeout ?? REQUEST_TIMEOUT_MS;
        const productLimitTotal = params.arguments?.productLimitTotal ?? DEFAULT_RETURNED_PRODUCTS;
        const productNmIds = params.arguments?.productNmIds;
        const queries =
            Array.isArray(rawQueries) &&
            rawQueries.map((item) => ({
                query: typeof item?.query === 'string' ? item.query.trim() : '',
                pages: item?.pages,
            }));
        const validQueries =
            Array.isArray(queries) &&
            queries.length >= 1 &&
            queries.length <= MAX_SEARCH_QUERIES &&
            queries.every(
                (item) =>
                    item.query.length >= 1 &&
                    item.query.length <= 300 &&
                    Number.isInteger(item.pages) &&
                    item.pages >= 1 &&
                    item.pages <= MAX_SEARCH_PAGES
            ) &&
            queries.reduce((total, item) => total + item.pages, 0) <= MAX_SEARCH_PAGES;
        if (!validQueries || !validTimeout(timeout) || !validProductProjection(productLimitTotal, productNmIds)) {
            mcpResult(
                id,
                textResult(
                    {
                        ok: false,
                        error: `queries must contain 1-${MAX_SEARCH_QUERIES} non-empty query/page objects with at most ${MAX_SEARCH_PAGES} pages total; projection or timeout is invalid`,
                    },
                    true
                )
            );
            return;
        }
        if (!(await waitForExtensionReady())) {
            mcpResult(id, textResult({ ok: false, error: 'The e-Comet Chrome extension is not connected' }, true));
            return;
        }

        const jobId = randomUUID();
        try {
            const writer = await createJobWriter(jobId);
            const units = queries.flatMap((querySpec, queryIndex) =>
                Array.from({ length: querySpec.pages }, (_, index) => ({
                    queryIndex,
                    query: querySpec.query,
                    page: index + 1,
                }))
            );
            const fetched = await runWithConcurrency(units, SEARCH_CONCURRENCY, async (unit) => {
                try {
                    const { url, response } = await requestWbFetchWithFallback(
                        requestWbFetch,
                        buildSearchUrls(unit.query, unit.page),
                        timeout
                    );
                    await writer.append({ jobId, ...unit, url, response });
                    return {
                        ...unit,
                        url,
                        response,
                        ok: isSuccessfulWbResponse(response) && Array.isArray(response?.data?.body?.products),
                    };
                } catch (error) {
                    await writer.append({ jobId, ...unit, error: error.message });
                    return { ...unit, ok: false, error: error.message };
                }
            });
            await writer.close();

            let returnedProducts = 0;
            const summaries = queries.map((querySpec, queryIndex) => {
                let globalOffset = 0;
                const pages = fetched
                    .filter((unit) => unit.queryIndex === queryIndex)
                    .sort((left, right) => left.page - right.page)
                    .map((unit) => {
                        const products = responseProducts(unit.response);
                        const remaining = Math.max(0, productLimitTotal - returnedProducts);
                        const selected = unit.ok
                            ? projectPageProducts(products, globalOffset, productNmIds, productNmIds ? MAX_RETURNED_PRODUCTS : remaining)
                            : [];
                        returnedProducts += selected.length;
                        const page = {
                            page: unit.page,
                            ok: unit.ok,
                            httpStatus: unit.response?.data?.status,
                            total: products.length,
                            overallTotal: numberOrUndefined(unit.response?.data?.body?.total),
                            products: selected,
                        };
                        if (!unit.ok) {
                            page.error =
                                unit.error || unit.response?.error || unit.response?.data?.statusText || 'WB search request failed';
                        }
                        globalOffset += products.length;
                        return page;
                    });
                return {
                    query: querySpec.query,
                    pagesRequested: querySpec.pages,
                    pagesSucceeded: pages.filter((page) => page.ok).length,
                    productsSeen: pages.reduce((total, page) => total + page.total, 0),
                    productsReturned: pages.reduce((total, page) => total + page.products.length, 0),
                    pages,
                };
            });
            const succeeded = fetched.filter((unit) => unit.ok).length;
            mcpResult(
                id,
                textResult({
                    ok: succeeded > 0,
                    status: normalizeStatus(succeeded, fetched.length),
                    jobId,
                    pagesRequested: fetched.length,
                    pagesSucceeded: succeeded,
                    pagesFailed: fetched.length - succeeded,
                    productFilterApplied: Boolean(productNmIds),
                    productLimitTotal: productNmIds ? undefined : productLimitTotal,
                    queries: summaries,
                    resultPath: writer.resultPath,
                })
            );
        } catch (error) {
            mcpResult(id, textResult({ ok: false, error: error.message }, true));
        }
        return;
    }

    if (params?.name === 'wb_recommendations_by_product') {
        const rawArticles = params.arguments?.articles;
        const timeout = params.arguments?.timeout ?? REQUEST_TIMEOUT_MS;
        const productLimitTotal = params.arguments?.productLimitTotal ?? DEFAULT_RETURNED_PRODUCTS;
        const productNmIds = params.arguments?.productNmIds;
        const validArticles =
            Array.isArray(rawArticles) &&
            rawArticles.length >= 1 &&
            rawArticles.length <= MAX_RECOMMENDATION_ARTICLES &&
            rawArticles.every(
                (item) =>
                    Number.isSafeInteger(item?.nmId) &&
                    item.nmId > 0 &&
                    (item.pages === undefined ||
                        (Number.isInteger(item.pages) && item.pages >= 1 && item.pages <= MAX_RECOMMENDATION_PAGES))
            );
        if (!validArticles || !validTimeout(timeout) || !validProductProjection(productLimitTotal, productNmIds)) {
            mcpResult(
                id,
                textResult(
                    {
                        ok: false,
                        error: `articles must contain 1-${MAX_RECOMMENDATION_ARTICLES} valid article/page objects; projection or timeout is invalid`,
                    },
                    true
                )
            );
            return;
        }
        if (!(await waitForExtensionReady())) {
            mcpResult(id, textResult({ ok: false, error: 'The e-Comet Chrome extension is not connected' }, true));
            return;
        }

        const articleMap = new Map();
        for (const article of rawArticles) {
            const current = articleMap.get(article.nmId);
            if (!current) {
                articleMap.set(article.nmId, {
                    nmId: article.nmId,
                    pages: article.pages,
                });
            } else if (current.pages === undefined || article.pages === undefined) {
                articleMap.set(article.nmId, { nmId: article.nmId, pages: undefined });
            } else {
                articleMap.set(article.nmId, {
                    nmId: article.nmId,
                    pages: Math.max(current.pages, article.pages),
                });
            }
        }
        const articles = [...articleMap.values()];
        const jobId = randomUUID();
        try {
            const writer = await createJobWriter(jobId);
            const fetchPage = async (unit) => {
                try {
                    const { url, response } = await requestWbFetchWithFallback(
                        requestWbFetch,
                        buildRecommendationUrls(unit.nmId, unit.page),
                        timeout
                    );
                    await writer.append({ jobId, ...unit, url, response });
                    return {
                        ...unit,
                        url,
                        response,
                        ok: isSuccessfulWbResponse(response) && Array.isArray(response?.data?.body?.products),
                    };
                } catch (error) {
                    await writer.append({ jobId, ...unit, error: error.message });
                    return { ...unit, ok: false, error: error.message };
                }
            };

            const firstPages = await runWithConcurrency(
                articles.map((article) => ({ ...article, page: 1 })),
                RECOMMENDATION_CONCURRENCY,
                fetchPage
            );
            const remainingUnits = [];
            for (const firstPage of firstPages) {
                const products = responseProducts(firstPage.response);
                const overallTotal = numberOrUndefined(firstPage.response?.data?.body?.total);
                const discoveredPages = recommendationTotalPages(overallTotal, products.length);
                const article = articleMap.get(firstPage.nmId);
                const requestedPages =
                    article.pages === undefined
                        ? Math.min(discoveredPages || 1, MAX_RECOMMENDATION_PAGES)
                        : Math.min(article.pages, discoveredPages || article.pages);
                for (let page = 2; page <= requestedPages; page += 1) {
                    remainingUnits.push({
                        nmId: firstPage.nmId,
                        pages: article.pages,
                        page,
                    });
                }
            }
            const remainingPages = await runWithConcurrency(remainingUnits, RECOMMENDATION_CONCURRENCY, fetchPage);
            const fetched = [...firstPages, ...remainingPages];
            await writer.close();

            let returnedProducts = 0;
            const summaries = articles.map((article) => {
                let globalOffset = 0;
                const articleUnits = fetched.filter((unit) => unit.nmId === article.nmId).sort((left, right) => left.page - right.page);
                const first = articleUnits[0];
                const firstProducts = responseProducts(first?.response);
                const overallTotal = numberOrUndefined(first?.response?.data?.body?.total);
                const discoveredPages = recommendationTotalPages(overallTotal, firstProducts.length);
                const pages = articleUnits.map((unit) => {
                    const products = responseProducts(unit.response);
                    const remaining = Math.max(0, productLimitTotal - returnedProducts);
                    const selected = unit.ok
                        ? projectPageProducts(products, globalOffset, productNmIds, productNmIds ? MAX_RETURNED_PRODUCTS : remaining)
                        : [];
                    returnedProducts += selected.length;
                    const page = {
                        page: unit.page,
                        ok: unit.ok,
                        httpStatus: unit.response?.data?.status,
                        total: products.length,
                        products: selected,
                    };
                    if (!unit.ok) {
                        page.error =
                            unit.error || unit.response?.error || unit.response?.data?.statusText || 'WB recommendation request failed';
                    }
                    globalOffset += products.length;
                    return page;
                });
                const summary = {
                    sourceNmId: article.nmId,
                    pagesRequested: pages.length,
                    pagesSucceeded: pages.filter((page) => page.ok).length,
                    overallTotal,
                    totalPages: discoveredPages,
                    productsSeen: pages.reduce((total, page) => total + page.total, 0),
                    productsReturned: pages.reduce((total, page) => total + page.products.length, 0),
                    pages,
                };
                if (discoveredPages === null) {
                    summary.incompleteReason = 'invalid_or_unsupported_total';
                } else if (article.pages === undefined && discoveredPages > MAX_RECOMMENDATION_PAGES) {
                    summary.incompleteReason = `shelf_exceeds_${MAX_RECOMMENDATION_PAGES}_page_safety_limit`;
                }
                return summary;
            });
            const succeeded = fetched.filter((unit) => unit.ok).length;
            mcpResult(
                id,
                textResult({
                    ok: succeeded > 0,
                    status: normalizeStatus(succeeded, fetched.length),
                    jobId,
                    pagesRequested: fetched.length,
                    pagesSucceeded: succeeded,
                    pagesFailed: fetched.length - succeeded,
                    productFilterApplied: Boolean(productNmIds),
                    productLimitTotal: productNmIds ? undefined : productLimitTotal,
                    articles: summaries,
                    resultPath: writer.resultPath,
                })
            );
        } catch (error) {
            mcpResult(id, textResult({ ok: false, error: error.message }, true));
        }
        return;
    }

    if (params?.name === 'wb_product_images') {
        const nmIds = params.arguments?.nmIds;
        const maxPhotos = params.arguments?.maxPhotos ?? DEFAULT_IMAGE_PHOTOS;
        const maxBasket = params.arguments?.maxBasket ?? MAX_IMAGE_BASKET;
        const size = params.arguments?.size ?? 'big';
        const timeout = params.arguments?.timeout ?? 5000;
        const valid =
            Array.isArray(nmIds) &&
            nmIds.length >= 1 &&
            nmIds.length <= MAX_IMAGE_ARTICLES &&
            nmIds.every((nmId) => Number.isSafeInteger(nmId) && nmId >= 10000 && nmId <= 9999999999) &&
            new Set(nmIds).size === nmIds.length &&
            Number.isInteger(maxPhotos) &&
            maxPhotos >= 1 &&
            maxPhotos <= MAX_IMAGE_PHOTOS &&
            Number.isInteger(maxBasket) &&
            maxBasket >= 1 &&
            maxBasket <= MAX_IMAGE_BASKET &&
            (size === 'big' || size === 'tm') &&
            typeof timeout === 'number' &&
            timeout >= 1000 &&
            timeout <= 30000;
        if (!valid) {
            mcpResult(id, textResult({ ok: false, error: 'Invalid image lookup arguments' }, true));
            return;
        }

        const jobId = randomUUID();
        try {
            const writer = await createJobWriter(jobId);
            const products = await runWithConcurrency(nmIds, IMAGE_CONCURRENCY, async (nmId) => {
                const discovered = await discoverImageBasket(nmId, maxBasket, size, timeout);
                if (!discovered) {
                    const result = { nmId, status: 'not_found', imageUrls: [] };
                    await writer.append(result);
                    return result;
                }
                const imageUrls = [];
                for (let photo = 1; photo <= maxPhotos; photo += 1) {
                    const url = `${discovered.baseUrl}/${size}/${photo}.webp`;
                    if (!(await imageExists(url, timeout))) break;
                    imageUrls.push(url);
                }
                const result = {
                    nmId,
                    status: imageUrls.length > 0 ? 'ok' : 'not_found',
                    basket: discovered.basket,
                    baseUrl: discovered.baseUrl,
                    imageUrls,
                };
                await writer.append(result);
                return result;
            });
            await writer.close();
            const succeeded = products.filter((product) => product.status === 'ok').length;
            mcpResult(
                id,
                textResult({
                    ok: succeeded > 0,
                    status: normalizeStatus(succeeded, products.length),
                    jobId,
                    total: products.length,
                    succeeded,
                    failed: products.length - succeeded,
                    size,
                    products,
                    resultPath: writer.resultPath,
                })
            );
        } catch (error) {
            mcpResult(id, textResult({ ok: false, error: error.message }, true));
        }
        return;
    }

    if (params?.name === 'wb_product_card') {
        const nmIds = params.arguments?.nmIds;
        const timeout = params.arguments?.timeout ?? REQUEST_TIMEOUT_MS;
        const validNmIds =
            Array.isArray(nmIds) &&
            nmIds.length >= 1 &&
            nmIds.length <= MAX_PRODUCT_ARTICLES &&
            nmIds.every((nmId) => Number.isSafeInteger(nmId) && nmId > 0) &&
            new Set(nmIds).size === nmIds.length;
        if (!validNmIds || !validTimeout(timeout)) {
            mcpResult(
                id,
                textResult(
                    {
                        ok: false,
                        error: `nmIds must contain 1-${MAX_PRODUCT_ARTICLES} unique positive integers; timeout must be ${MIN_REQUEST_TIMEOUT_MS}-${MAX_REQUEST_TIMEOUT_MS} ms`,
                    },
                    true
                )
            );
            return;
        }
        if (!(await waitForExtensionReady())) {
            mcpResult(id, textResult({ ok: false, error: 'The e-Comet Chrome extension is not connected' }, true));
            return;
        }

        const jobId = randomUUID();
        try {
            const writer = await createJobWriter(jobId);
            const products = await runWithConcurrency(nmIds, PRODUCT_CARD_CONCURRENCY, async (nmId) => {
                try {
                    const response = await requestWbFetch(productDetailUrl(nmId), timeout);
                    await writer.append({ jobId, nmId, response });
                    return summarizeProduct(nmId, response);
                } catch (error) {
                    const failure = { requestId: null, error: error.message };
                    await writer.append({ jobId, nmId, response: failure });
                    return { nmId, ok: false, error: error.message };
                }
            });
            await writer.close();
            const succeeded = products.filter((product) => product.ok).length;
            mcpResult(
                id,
                textResult({
                    ok: succeeded > 0,
                    status: succeeded === products.length ? 'done' : succeeded === 0 ? 'failed' : 'partial',
                    jobId,
                    total: products.length,
                    succeeded,
                    failed: products.length - succeeded,
                    products,
                    resultPath: writer.resultPath,
                })
            );
        } catch (error) {
            mcpResult(id, textResult({ ok: false, error: error.message }, true));
        }
        return;
    }

    if (params?.name !== 'local_wb_fetch') {
        mcpError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
    }

    const url = params.arguments?.url;
    const timeout = params.arguments?.timeout ?? REQUEST_TIMEOUT_MS;
    if (typeof url !== 'string' || !isAllowedWbUrl(url)) {
        mcpResult(
            id,
            textResult(
                {
                    ok: false,
                    error: 'Only approved Wildberries endpoint families are allowed',
                },
                true
            )
        );
        return;
    }
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < MIN_REQUEST_TIMEOUT_MS || timeout > MAX_REQUEST_TIMEOUT_MS) {
        mcpResult(
            id,
            textResult(
                {
                    ok: false,
                    error: `timeout must be a number between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS} ms`,
                },
                true
            )
        );
        return;
    }
    if (!(await waitForExtensionReady())) {
        mcpResult(id, textResult({ ok: false, error: 'The e-Comet Chrome extension is not connected' }, true));
        return;
    }

    try {
        const response = await requestWbFetch(url, timeout);
        const requestId = response?.requestId || randomUUID();
        const resultPath = await saveResult(requestId, response);
        mcpResult(
            id,
            textResult({
                ok: !response?.error && response?.data?.ok !== false,
                requestId,
                status: response?.data?.status,
                statusText: response?.data?.statusText,
                error: response?.error,
                body: summarizeBody(response?.data?.body),
                resultPath,
            })
        );
    } catch (error) {
        mcpResult(id, textResult({ ok: false, error: error.message }, true));
    }
};

let stdinBuffer = '';
let discardingOversizedStdinLine = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    if (discardingOversizedStdinLine) {
        const newlineIndex = chunk.indexOf('\n');
        if (newlineIndex < 0) {
            return;
        }
        discardingOversizedStdinLine = false;
        chunk = chunk.slice(newlineIndex + 1);
    }
    stdinBuffer += chunk;
    if (Buffer.byteLength(stdinBuffer, 'utf8') > MAX_MCP_MESSAGE_BYTES && !stdinBuffer.includes('\n')) {
        stdinBuffer = '';
        discardingOversizedStdinLine = true;
        mcpError(null, -32600, `MCP message exceeds ${MAX_MCP_MESSAGE_BYTES} bytes`);
        return;
    }
    let newlineIndex;
    while ((newlineIndex = stdinBuffer.indexOf('\n')) >= 0) {
        const rawLine = stdinBuffer.slice(0, newlineIndex);
        stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
        if (Buffer.byteLength(rawLine, 'utf8') > MAX_MCP_MESSAGE_BYTES) {
            mcpError(null, -32600, `MCP message exceeds ${MAX_MCP_MESSAGE_BYTES} bytes`);
            continue;
        }
        const line = rawLine.trim();
        if (!line) continue;
        try {
            void handleMcpMessage(JSON.parse(line));
        } catch {
            mcpError(null, -32700, 'Parse error');
        }
    }
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        log(`local bridge already exists at ${HOST}:${PORT}; using it as the primary instance`);
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
            peerSocket?.close();
            peerSocket = null;
            peerReady = false;
            peerExtensionReady = false;
            peerExtensionBrowserJobReady = false;
            takeoverGranted = false;
            listenerYieldUntil = 0;
            handoffTarget = null;
            log(`listening on ws://${HOST}:${PORT}${PATH} as generation ${BRIDGE_GENERATION} version ${BRIDGE_VERSION}`);
        });
    } catch (error) {
        log('failed to start local bridge listener:', error.message);
    }
};

startBridgeListener();
