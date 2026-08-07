import { createHash, randomUUID } from 'node:crypto';

import {
    ALLOWED_EXTENSION_IDS,
    BRIDGE_GENERATION,
    BRIDGE_VERSION,
    CONTROL_PROTOCOL_VERSION,
    EXTENSION_ID_OVERRIDE_ENABLED,
    EXTENSION_PROTOCOL_VERSION,
    HANDOFF_DRAIN_POLL_MS,
    HANDOFF_MAX_DRAIN_MS,
    HANDOFF_RECONNECT_GRACE_MS,
    PEER_HANDSHAKE_TIMEOUT_MS,
    PEER_RECONNECT_MAX_MS,
    PEER_WAKE_COOLDOWN_MS,
    SESSION_NONCE,
    WS_HEARTBEAT_INTERVAL_MS,
} from './config.mjs';
import { PEER_REJECTION_CODES } from './connection-state.mjs';
import { localMessage, MESSAGE_TYPES, peerStatusMessage } from './extension-vocabulary.mjs';
import { encodeFrame, parseFrames, sendWs } from './websocket.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isAllowedExtensionOrigin = (origin) => {
    if (!origin.startsWith('chrome-extension://')) return false;
    return ALLOWED_EXTENSION_IDS.has(origin.slice('chrome-extension://'.length));
};

export const createBridgeRuntime = ({
    host,
    port,
    extensionPath,
    peerPath,
    createHttpServer,
    createWebSocket,
    extensionProtocol,
    peerProtocol,
    handoff,
    connections,
    log,
    // Only a test seam: a suite cannot wait out the production deadline to prove a silent peer is abandoned.
    peerHandshakeTimeoutMs = PEER_HANDSHAKE_TIMEOUT_MS,
}) => {
    const acceptedPeerStates = new Set();
    const connectionStates = new Set();
    let closed = false;
    // Guards a listener attempt between `listen()` and its callback or 'error' event, where `server.listening`
    // is still false. Without it two nearly simultaneous wake-ups both reach `listen()`.
    let bridgeStartPending = false;
    let lastBridgeStartAttemptAtMs = null;
    // Which classifications the current degraded episode has already announced. A retry is never logged on its
    // own — a process that lives for days would write a line every 30 seconds — and a code that alternates
    // between attempts cannot re-announce either, because each one is only ever recorded once. The set is
    // bounded by the closed rejection vocabulary and is emptied when the episode ends.
    const announcedDegradedCodes = new Set();

    const server = createHttpServer((request, response) => {
        if (request.url === '/health' && request.headers?.host === `${host}:${port}`) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, extensionConnected: connections.extensionReady }));
            return;
        }
        response.writeHead(404);
        response.end();
    });

    const currentPeerStatus = () =>
        peerStatusMessage({
            connections,
            handoff,
            bridgeGeneration: BRIDGE_GENERATION,
            bridgeVersion: BRIDGE_VERSION,
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
        });

    const broadcastPeerStatus = () => {
        const message = currentPeerStatus();
        for (const state of acceptedPeerStates) {
            if (!state.peerHandshakeComplete) continue;
            try {
                sendWs(state.socket, message);
            } catch {
                acceptedPeerStates.delete(state);
            }
        }
    };

    const sendPeerControl = (state, message) => {
        try {
            sendWs(state.socket, message);
            return true;
        } catch {
            return false;
        }
    };

    let connectToPrimaryBridge;
    const relinquishBridge = (effect) => {
        handoff.deferListener();
        // Close the narrow post-drain window before clearing the socket: new work must fail retryably, not wait for its timeout.
        effect.invalidateAuthorizationWork();
        const currentExtensionSocket = connections.extensionSocket;
        connections.disconnectExtension(currentExtensionSocket);

        server.close(() => {
            // Deliberately reconnects as a peer rather than going through start(): the port was just handed to
            // the promoted instance, and re-entering the listen path would race it for the port we gave away.
            scheduleBridgeStart(250, connectToPrimaryBridge);
        });
        // close() waits for every open connection, and an idle keep-alive client on /health is tracked by
        // neither connectionStates nor acceptedPeerStates, so nothing below would end it. Without this the
        // callback above can never run and the process is left with no listener, no peer and no armed retry.
        server.closeIdleConnections?.();

        currentExtensionSocket?.end(encodeFrame('', 0x8));
        for (const state of [...acceptedPeerStates]) {
            state.socket.end(encodeFrame('', 0x8));
        }
        const destroyTimer = setTimeout(() => {
            currentExtensionSocket?.destroy();
            for (const state of [...acceptedPeerStates]) {
                state.socket.destroy();
            }
            // Anything still holding the server open past the grace, including a keep-alive request in flight.
            server.closeAllConnections?.();
        }, 100);
        destroyTimer.unref?.();
    };

    const beginHandoff = async (effect) => {
        const targetState = effect.state;
        if (!handoff.begin(targetState)) return;
        const notice = {
            type: 'peer_handoff',
            controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
            targetInstanceId: targetState.peerInstanceId,
            targetGeneration: targetState.peerGeneration,
            reconnectGraceMs: HANDOFF_RECONNECT_GRACE_MS,
        };
        for (const state of acceptedPeerStates) {
            if (!state.peerHandshakeComplete) continue;
            sendPeerControl(state, notice);
        }
        log(
            `handoff requested by generation ${targetState.peerGeneration} instance ${targetState.peerInstanceId}; ` +
                `draining ${effect.activeRequestCount()} active request(s)`
        );

        const drainDeadline = connections.now() + HANDOFF_MAX_DRAIN_MS;
        while (effect.activeRequestCount() > 0 && handoff.isTarget(targetState) && !targetState.socket.destroyed) {
            if (connections.now() >= drainDeadline) {
                log(`handoff drain exceeded ${HANDOFF_MAX_DRAIN_MS} ms; invalidating active browser-job authorization work`);
                effect.invalidateAuthorizationWork();
                break;
            }
            await delay(HANDOFF_DRAIN_POLL_MS);
        }
        if (!handoff.isTarget(targetState) || targetState.socket.destroyed) {
            handoff.cancel(targetState);
            for (const state of acceptedPeerStates) {
                if (!state.peerHandshakeComplete) continue;
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
        relinquishBridge(effect);
    };

    const closeConnectionState = (state, { destroySocket = true } = {}) => {
        if (state.closed) return;
        state.closed = true;
        clearInterval(state.heartbeatTimer);
        acceptedPeerStates.delete(state);
        connectionStates.delete(state);
        if (state.path === peerPath) peerProtocol.onDisconnect(state);
        else extensionProtocol.onDisconnect(state);
        if (destroySocket) state.socket.destroy();
    };

    server.on('upgrade', (request, socket) => {
        if (
            (request.url !== extensionPath && request.url !== peerPath) ||
            request.headers.upgrade?.toLowerCase() !== 'websocket' ||
            !request.headers['sec-websocket-key']
        ) {
            socket.destroy();
            return;
        }

        const origin =
            request.headers.origin || (EXTENSION_ID_OVERRIDE_ENABLED ? process.env.ECOMET_LOCAL_BRIDGE_TEST_ORIGIN || '' : '');
        if (
            (request.url === extensionPath && !isAllowedExtensionOrigin(origin)) ||
            (origin && !origin.startsWith('chrome-extension://'))
        ) {
            log('rejected WebSocket origin');
            socket.destroy();
            return;
        }

        const accept = createHash('sha1')
            .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
        socket.write(
            [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${accept}`,
                '',
                '',
            ].join('\r\n')
        );

        const protocolState =
            request.url === peerPath
                ? peerProtocol.createState(socket)
                : {
                      socket,
                      extensionHandshakeComplete: false,
                  };
        const state = Object.assign(protocolState, {
            buffer: Buffer.alloc(0),
            socket,
            path: request.url,
            origin,
            fragmentOpcode: null,
            fragments: [],
            fragmentBytes: 0,
            awaitingPong: false,
            heartbeatTimer: null,
            closed: false,
        });
        connectionStates.add(state);
        if (request.url === peerPath) acceptedPeerStates.add(state);

        if (request.url === extensionPath) {
            state.helloId = randomUUID();
            sendWs(
                socket,
                localMessage(state.helloId, MESSAGE_TYPES.hello, {
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
                closeConnectionState(state);
                return;
            }
            if (state.awaitingPong) {
                log(`closing unresponsive WebSocket client on ${state.path}`);
                closeConnectionState(state);
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
                    (message) => {
                        const operation =
                            state.path === peerPath
                                ? peerProtocol.handleMessage(state, message)
                                : extensionProtocol.handleMessage(state, message);
                        void Promise.resolve(operation)
                            .then((effect) => {
                                if (effect?.type === 'handoff_requested') return beginHandoff(effect);
                            })
                            .catch((error) => log('WebSocket message handling failed:', error.message));
                    },
                    (closeFrameSent) => closeConnectionState(state, { destroySocket: !closeFrameSent })
                );
            } catch (error) {
                log('WebSocket protocol error:', error.message);
                closeConnectionState(state);
            }
        });
        socket.on('close', () => closeConnectionState(state));
        socket.on('error', () => closeConnectionState(state));
    });

    // One spelling of "this peer socket is worth waiting on", so a change to what counts as live cannot apply to
    // some callers and not others. CONNECTING is included deliberately: an attempt already in flight must not be
    // duplicated.
    const peerSocketLive = () =>
        Boolean(connections.peerSocket) && [WebSocket.CONNECTING, WebSocket.OPEN].includes(connections.peerSocket.readyState);

    // Both ways out of a degraded episode end here, so the transition is announced exactly once whichever role
    // the process recovers into.
    const noteDegradedEpisodeEnded = (recovery) => {
        if (announcedDegradedCodes.size === 0) return;
        if (recovery !== 'primary' && !connections.peerReady) return;
        announcedDegradedCodes.clear();
        log(
            recovery === 'primary'
                ? 'recovered from the degraded peer state by taking over the local bridge listener'
                : 'recovered from the degraded peer state by reconnecting to the primary local bridge'
        );
    };

    const start = () => {
        if (closed || server.listening || bridgeStartPending) return;
        // Only an attempt that actually reaches `listen()` moves the cooldown. Stamping before the guards would
        // let no-op wake-ups push the next real attempt further away.
        lastBridgeStartAttemptAtMs = connections.now();
        bridgeStartPending = true;
        try {
            // Operational listen failures arrive through 'error'; keep this guard for synchronous argument/state errors.
            server.listen(port, host, () => {
                bridgeStartPending = false;
                // An earlier listen failure marked the process as failed. Now that a retry has succeeded that
                // verdict is stale, and leaving it would make a healthy agent exit non-zero on shutdown.
                if (process.exitCode === 1) process.exitCode = 0;
                noteDegradedEpisodeEnded('primary');
                connections.resetPeerAfterListen();
                handoff.resetAfterListen();
                log(`listening on ws://${host}:${port}${extensionPath} as generation ${BRIDGE_GENERATION} version ${BRIDGE_VERSION}`);
            });
        } catch (error) {
            // A synchronous throw runs neither the listen callback nor the 'error' event, so the flag has to be
            // released here too. Leaving it set would disable every later recovery attempt without a trace.
            bridgeStartPending = false;
            log('failed to start local bridge listener:', error.message);
        }
    };

    // The single owner of the reconnect timer: it cancels whatever was pending, publishes the retry time that
    // `local_bridge_status` reports, and clears both before handing control to the attempt.
    const scheduleBridgeStart = (delayMs, run = start) => {
        if (closed) return;
        connections.clearPeerRetrySchedule();
        // The runtime stamps the absolute time itself: `ensureBridgeConnected` compares this against its own
        // clock, and letting the two sides read different injected clocks would make the comparison meaningless.
        connections.notePeerRetryScheduled(connections.now() + delayMs);
        connections.peerReconnectTimer = setTimeout(() => {
            connections.clearPeerRetrySchedule();
            run();
        }, delayMs);
    };

    // Lets a tool call pull the next attempt forward instead of waiting out the degraded interval. Every guard
    // below exists to keep that shortcut from doing damage: it never runs beside an attempt already in flight,
    // never more often than the cooldown, never during a handoff, and never in place of a schedule that is
    // about to fire on its own.
    const ensureBridgeConnected = () => {
        if (closed || server.listening || bridgeStartPending) return;
        if (peerSocketLive()) return;
        if (lastBridgeStartAttemptAtMs !== null && connections.now() - lastBridgeStartAttemptAtMs < PEER_WAKE_COOLDOWN_MS) return;
        // A deferred listener means the port belongs to an instance being promoted. Between server.close() and
        // its callback nothing is published yet, so without this a wake-up in that window would arm a start()
        // that re-binds the port mid-handoff. The relinquish path owns the next attempt; stand down entirely.
        if (handoff.retryDelay(0) > 0) return;
        // Pull an attempt forward, never push one back, and never replace a schedule that is about to fire
        // anyway. The post-handoff peer reconnect and the takeover poll are both scheduled tighter than the
        // wake-up cooldown; taking them over would delay recovery and, worse, swap a deliberate peer reconnect
        // for a listen attempt that races the instance the port was just handed to.
        const scheduledSoonEnough =
            connections.peerNextRetryAtMs !== null && connections.peerNextRetryAtMs <= connections.now() + PEER_WAKE_COOLDOWN_MS;
        if (scheduledSoonEnough) return;
        scheduleBridgeStart(0);
    };

    connectToPrimaryBridge = () => {
        if (closed) return;
        if (peerSocketLive()) return;

        const socket = createWebSocket(`ws://${host}:${port}${peerPath}`);
        const state = peerProtocol.createState(socket, { role: 'client' });
        connections.clearPeerAttemptVerdict();
        connections.peerSocket = socket;
        // A peer that never answers leaves this socket silent forever: no 'close' fires, so nothing schedules the
        // next attempt, and `ensureBridgeConnected` keeps seeing a live socket and stands down. That silence can
        // fall either side of the upgrade — a connect stuck in SYN_SENT, or a process that accepts the socket
        // and then stalls — so the deadline covers the whole handshake, not just the connect, and is only
        // cleared once the peer has actually completed one. Forcing the socket closed restores the normal path.
        const handshakeDeadline = setTimeout(() => {
            if (state.peerHandshakeComplete) return;
            log('peer did not complete a handshake in time; abandoning the attempt');
            socket.close();
        }, peerHandshakeTimeoutMs);
        handshakeDeadline.unref?.();
        socket.addEventListener('open', () => {
            socket.send(JSON.stringify(state.outboundHello));
        });
        socket.addEventListener('message', (event) => {
            void Promise.resolve(peerProtocol.handleMessage(state, event.data))
                .then(() => {
                    if (state.peerHandshakeComplete) clearTimeout(handshakeDeadline);
                    // Readiness is only ever reached by handling a peer_welcome or peer_status frame, so this is
                    // the moment a degraded episode ends by reconnecting rather than by taking over the listener.
                    // Closing it here, not lazily at the next disconnect, keeps one source of truth for it.
                    noteDegradedEpisodeEnded('peer');
                })
                .catch((error) => log('peer protocol handling failed:', error.message));
        });
        const disconnected = () => {
            clearTimeout(handshakeDeadline);
            const result = peerProtocol.onDisconnect(state);
            if (!result.disconnected || closed) return;
            const reconnectDelay = result.shouldTakeover
                ? HANDOFF_DRAIN_POLL_MS
                : Math.max(result.reconnectDelay, handoff.retryDelay());
            if (!result.shouldTakeover && result.saturated && !announcedDegradedCodes.has(connections.peerRejectionCode)) {
                announcedDegradedCodes.add(connections.peerRejectionCode);
                log(
                    `degraded: no usable primary local bridge (${connections.peerRejectionCode}); ` +
                        `retrying every ${Math.round(reconnectDelay / 1000)}s until it returns`
                );
            }
            scheduleBridgeStart(reconnectDelay);
        };
        socket.addEventListener('close', disconnected, { once: true });
        socket.addEventListener('error', () => socket.close(), { once: true });
    };

    server.on('error', (error) => {
        // 'error' also fires for handle-level failures after the port is bound. Those are not listen attempts:
        // treating one as such would cancel the single-flight guard for a listen genuinely in flight and pin a
        // permanent rejection on a primary that is serving traffic, since nothing a still-listening process does
        // will clear it.
        if (server.listening) {
            log(`local bridge listener error while serving ${host}:${port}:`, error.message);
            return;
        }
        // Released before the EADDRINUSE branch returns: that is the common path here, and a flag left set there
        // would make every later ensureBridgeConnected() a silent no-op.
        bridgeStartPending = false;
        if (error.code === 'EADDRINUSE') {
            if (connections.peerReconnectBackoffStep === 0) {
                log(`local bridge already exists at ${host}:${port}; using it as the primary instance`);
            }
            connectToPrimaryBridge();
            return;
        }
        // Not a contended port but a refused one — an excluded loopback range, for instance. The timer that ran
        // this attempt has already cleared itself, so without re-arming here the process would sit with no
        // listener, no peer and no scheduled retry, contradicting the invariant that reconnection never gives up.
        log(`failed to listen on ${host}:${port}:`, error.message);
        process.exitCode = 1;
        connections.recordPeerRejection(PEER_REJECTION_CODES.connectionFailed);
        scheduleBridgeStart(PEER_RECONNECT_MAX_MS);
    });

    const close = () => {
        if (closed) return;
        closed = true;
        bridgeStartPending = false;
        connections.clearPeerRetrySchedule();
        connections.clearPeerAttemptVerdict();
        connections.close?.();
        connections.peerSocket?.close();
        for (const state of [...connectionStates]) {
            closeConnectionState(state);
        }
        if (server.listening) server.close();
    };

    const status = () => {
        const peerRejection = connections.peerRejectionStatus();
        return {
            extensionConnected: connections.effectiveExtensionReady,
            browserJobSupported: connections.effectiveBrowserJobReady,
            bridgeRole: server.listening ? 'primary' : connections.peerReady ? 'secondary' : 'disconnected',
            bridgeTransitioning: handoff.transitioning,
            ...(peerRejection === undefined ? {} : { peerRejection }),
        };
    };
    status.broadcast = broadcastPeerStatus;

    return { start, close, status, ensureBridgeConnected };
};
