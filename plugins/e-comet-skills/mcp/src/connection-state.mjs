// Peer failures are reported to the agent, so the vocabulary is a closed set owned by this process. A reason
// string received from the other side of the socket is never surfaced: anything listening on loopback could
// otherwise write arbitrary text into a tool result and from there into the model's context.
export const PEER_REJECTION_CODES = Object.freeze({
    authenticationFailed: 'authentication_failed',
    protocolMismatch: 'protocol_mismatch',
    handshakeRequired: 'handshake_required',
    connectionFailed: 'connection_failed',
});

export class ConnectionState {
    #extensionReadyWaiters = new Set();
    #closed = false;
    #now;

    extensionSocket = null;
    extensionReady = false;
    extensionBrowserJobReady = false;
    peerSocket = null;
    peerReady = false;
    peerExtensionReady = false;
    peerExtensionBrowserJobReady = false;
    peerReconnectTimer = null;
    peerReconnectBackoffStep = 0;
    // Classification of the attempt currently in flight. Cleared when an attempt ends, so a socket that closes
    // after a protocol-level rejection cannot overwrite the more specific code with a generic one.
    peerAttemptRejectionCode = null;
    // Last classified failure of the current uninterrupted streak, and when that streak began.
    peerRejectionCode = null;
    peerFailureSinceMs = null;
    peerNextRetryAtMs = null;

    constructor({ now = Date.now } = {}) {
        this.#now = now;
    }

    get effectiveExtensionReady() {
        return this.extensionReady || (this.peerReady && this.peerExtensionReady);
    }

    get effectiveBrowserJobReady() {
        return this.extensionBrowserJobReady || (this.peerReady && this.peerExtensionBrowserJobReady);
    }

    connectExtension(socket, browserJobSupported) {
        const previousSocket = this.extensionSocket;
        this.extensionSocket = socket;
        this.extensionReady = true;
        this.extensionBrowserJobReady = browserJobSupported;
        this.#resolveExtensionReadyWaiters();
        return previousSocket && previousSocket !== socket ? previousSocket : null;
    }

    disconnectExtension(socket) {
        if (this.extensionSocket !== socket) return false;
        this.extensionSocket = null;
        this.extensionReady = false;
        this.extensionBrowserJobReady = false;
        return true;
    }

    updatePeerStatus({ extensionConnected, browserJobSupported }) {
        const wasReady = this.peerReady;
        this.resetPeerReconnect();
        this.peerReady = true;
        this.peerExtensionReady = extensionConnected === true;
        this.peerExtensionBrowserJobReady = browserJobSupported === true;
        this.#resolveExtensionReadyWaiters();
        return wasReady;
    }

    waitForExtensionReady(timeoutMs) {
        if (this.#closed) return Promise.resolve(false);
        if (this.effectiveExtensionReady) return Promise.resolve(true);
        return new Promise((resolve) => {
            const waiter = (ready) => {
                clearTimeout(waiter.timer);
                this.#extensionReadyWaiters.delete(waiter);
                resolve(ready);
            };
            waiter.timer = setTimeout(() => waiter(false), timeoutMs);
            this.#extensionReadyWaiters.add(waiter);
            if (this.effectiveExtensionReady) waiter(true);
        });
    }

    close() {
        if (this.#closed) return;
        this.#closed = true;
        for (const waiter of [...this.#extensionReadyWaiters]) waiter(false);
    }

    #resolveExtensionReadyWaiters() {
        if (!this.effectiveExtensionReady) return;
        for (const waiter of [...this.#extensionReadyWaiters]) waiter(true);
    }

    disconnectPeer(socket) {
        if (this.peerSocket !== socket) return false;
        this.peerSocket = null;
        this.peerReady = false;
        this.peerExtensionReady = false;
        this.peerExtensionBrowserJobReady = false;
        return true;
    }

    resetPeerAfterListen() {
        this.peerSocket?.close();
        this.peerSocket = null;
        this.peerReady = false;
        this.peerExtensionReady = false;
        this.peerExtensionBrowserJobReady = false;
        this.resetPeerReconnect();
    }

    beginPeerAttempt() {
        this.peerAttemptRejectionCode = null;
    }

    endPeerAttempt() {
        this.peerAttemptRejectionCode = null;
    }

    // A protocol-level verdict: always authoritative for the attempt in flight.
    recordPeerRejection(code) {
        const rejectionCode = Object.values(PEER_REJECTION_CODES).includes(code) ? code : PEER_REJECTION_CODES.connectionFailed;
        this.peerAttemptRejectionCode = rejectionCode;
        this.peerRejectionCode = rejectionCode;
        this.peerFailureSinceMs ??= this.#now();
    }

    // A socket that closed without telling us why. Never downgrades a verdict already reached for this attempt.
    classifyPeerCloseFailure() {
        if (this.peerAttemptRejectionCode !== null) return;
        this.recordPeerRejection(PEER_REJECTION_CODES.connectionFailed);
    }

    // Saturation is a property of the delay, not of an attempt count: once the curve reaches its ceiling the
    // secondary is degraded and stays there, retrying at that cadence until it reconnects or becomes primary.
    nextPeerReconnectDelay({ baseMs, maxMs }) {
        const delayMs = Math.min(maxMs, baseMs * 2 ** this.peerReconnectBackoffStep);
        const saturated = delayMs >= maxMs;
        if (!saturated) this.peerReconnectBackoffStep += 1;
        return { delayMs, saturated };
    }

    notePeerRetryScheduled(delayMs) {
        this.peerNextRetryAtMs = this.#now() + delayMs;
    }

    clearPeerRetrySchedule() {
        clearTimeout(this.peerReconnectTimer);
        this.peerReconnectTimer = null;
        this.peerNextRetryAtMs = null;
    }

    // Absent while the bridge is healthy: a null-filled object in every status would be noise in the agent's context.
    peerRejectionStatus() {
        if (this.peerRejectionCode === null || this.peerFailureSinceMs === null) return undefined;
        return {
            code: this.peerRejectionCode,
            since: new Date(this.peerFailureSinceMs).toISOString(),
            ...(this.peerNextRetryAtMs === null ? {} : { retryAt: new Date(this.peerNextRetryAtMs).toISOString() }),
        };
    }

    resetPeerReconnect() {
        this.clearPeerRetrySchedule();
        this.peerReconnectBackoffStep = 0;
        this.peerAttemptRejectionCode = null;
        this.peerRejectionCode = null;
        this.peerFailureSinceMs = null;
    }
}
