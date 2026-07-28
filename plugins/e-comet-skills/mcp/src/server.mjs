#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { createBridgeRuntime } from './bridge-runtime.mjs';
import {
    BRIDGE_GENERATION,
    BRIDGE_VERSION,
    CONTROL_PROTOCOL_VERSION,
    EXTENSION_READINESS_WAIT_MS,
    EXTENSION_PATH,
    EXTENSION_PROTOCOL_VERSION,
    HANDOFF_DRAIN_POLL_MS,
    HANDOFF_RECONNECT_GRACE_MS,
    HOST,
    PEER_PATH,
    PORT,
    RESULT_DIR,
    SESSION_NONCE,
} from './config.mjs';
import { ConnectionState } from './connection-state.mjs';
import { createExtensionProtocol } from './extension-protocol.mjs';
import { HandoffState } from './handoff-state.mjs';
import { createMcpMessageHandler } from './mcp-dispatcher.mjs';
import { mcpError } from './mcp-protocol.mjs';
import { loadOrCreatePeerToken } from './peer-auth.mjs';
import { createPeerProtocol } from './peer-protocol.mjs';
import { RequestBroker } from './request-broker.mjs';
import { attachStdioTransport } from './stdio-transport.mjs';
import { sendWs } from './websocket.mjs';

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

const instanceId = randomUUID();
const peerToken = await loadPeerTokenOrExit();
const connections = new ConnectionState();
const handoff = new HandoffState({
    generation: BRIDGE_GENERATION,
    instanceId,
    reconnectGraceMs: HANDOFF_RECONNECT_GRACE_MS,
});

const localMessage = (id, type, payload) => ({ id, type, payload });
const waitForBridgeTransition = async (timeout) => {
    if (!handoff.transitioning) return;
    const deadline = Date.now() + Math.min(timeout, 10000);
    while (handoff.transitioning) {
        if (Date.now() >= deadline) {
            throw new Error('Local bridge upgrade did not complete before the request timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, HANDOFF_DRAIN_POLL_MS));
    }
};

const requestBroker = new RequestBroker({
    waitForTransition: waitForBridgeTransition,
    routeWbFetch: ({ requestId, url, timeout, authorizationId, authorizationScopeId }) => {
        if (connections.extensionReady) {
            sendWs(connections.extensionSocket, localMessage(requestId, 'wb_fetch', { url, timeout, authorizationId }));
        } else if (connections.peerReady && connections.peerSocket?.readyState === WebSocket.OPEN) {
            connections.peerSocket.send(
                JSON.stringify({
                    type: 'peer_wb_fetch',
                    requestId,
                    url,
                    timeout,
                    authorizationId,
                    authorizationScopeId,
                })
            );
        } else {
            throw new Error('The e-Comet Chrome extension is not connected');
        }
    },
    routeAuthorization: ({ requestId, token }) => {
        if (connections.extensionReady && !connections.extensionBrowserJobReady) {
            throw new Error('The e-Comet Chrome extension must be updated to support signed browser jobs');
        }
        if (connections.extensionBrowserJobReady) {
            const extensionSocket = connections.extensionSocket;
            sendWs(extensionSocket, localMessage(requestId, 'browser_job_authorize', { token }));
            return {
                isActive: () => connections.extensionReady && connections.extensionSocket === extensionSocket,
            };
        }
        if (connections.peerReady && !connections.peerExtensionBrowserJobReady) {
            throw new Error('The e-Comet Chrome extension must be updated to support signed browser jobs');
        }
        if (connections.peerExtensionBrowserJobReady && connections.peerSocket?.readyState === WebSocket.OPEN) {
            const peerSocket = connections.peerSocket;
            peerSocket.send(JSON.stringify({ type: 'peer_browser_job_authorize', requestId, token }));
            return {
                isActive: () =>
                    connections.peerReady && connections.peerSocket === peerSocket && peerSocket.readyState === WebSocket.OPEN,
                release: () => {
                    if (peerSocket.readyState !== WebSocket.OPEN) return;
                    try {
                        peerSocket.send(
                            JSON.stringify({
                                type: 'peer_browser_job_authorization_release',
                                authorizationScopeId: requestId,
                            })
                        );
                    } catch (error) {
                        log('failed to release peer browser-job authorization:', error.message);
                    }
                },
            };
        }
        throw new Error('The e-Comet Chrome extension is not connected');
    },
});

let runtime;
const broadcastStatus = () => runtime?.status.broadcast();
const extensionProtocol = createExtensionProtocol({
    connections,
    requestBroker,
    handoff,
    sessionNonce: SESSION_NONCE,
    send: sendWs,
    log,
    broadcastStatus,
});
const peerProtocol = createPeerProtocol({
    connections,
    requestBroker,
    handoff,
    peerToken,
    send: sendWs,
    log,
    broadcastStatus,
});
runtime = createBridgeRuntime({
    host: HOST,
    port: PORT,
    extensionPath: EXTENSION_PATH,
    peerPath: PEER_PATH,
    createHttpServer: createServer,
    createWebSocket: (url) => new WebSocket(url),
    extensionProtocol,
    peerProtocol,
    handoff,
    connections,
    log,
});

const requestBrowserJobAuthorization = (...args) => requestBroker.requestAuthorization(...args);
const handleMcpMessage = createMcpMessageHandler({
    getBridgeStatus: () => ({
        ...runtime.status(),
        bridgeVersion: BRIDGE_VERSION,
        bridgeGeneration: BRIDGE_GENERATION,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
        extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
        instanceId,
        websocket: `ws://${HOST}:${PORT}${EXTENSION_PATH}`,
        resultDirectory: RESULT_DIR,
    }),
    waitForExtensionReady: () => connections.waitForExtensionReady(EXTENSION_READINESS_WAIT_MS),
    requestBrowserJobAuthorization,
});

attachStdioTransport({ handleMessage: handleMcpMessage, sendError: mcpError });
runtime.start();
