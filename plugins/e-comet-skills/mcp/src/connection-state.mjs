export class ConnectionState {
    extensionSocket = null;
    extensionReady = false;
    extensionBrowserJobReady = false;
    peerSocket = null;
    peerReady = false;
    peerExtensionReady = false;
    peerExtensionBrowserJobReady = false;
    peerReconnectTimer = null;
    peerReconnectAttempts = 0;
    peerRejectionReason = null;

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
        return wasReady;
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

    recordPeerRejection(reason) {
        this.peerRejectionReason = reason || 'unknown reason';
    }

    nextPeerReconnectDelay({ baseMs, maxMs, maxAttempts }) {
        if (this.peerReconnectAttempts >= maxAttempts) return null;
        const delay = Math.min(maxMs, baseMs * 2 ** this.peerReconnectAttempts);
        this.peerReconnectAttempts += 1;
        return delay;
    }

    resetPeerReconnect() {
        this.peerReconnectAttempts = 0;
        this.peerRejectionReason = null;
    }
}
