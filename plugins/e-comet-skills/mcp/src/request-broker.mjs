import { randomUUID } from 'node:crypto';

import { REQUEST_TIMEOUT_MS } from './config.mjs';
import { isAllowedWbUrl } from './wb-domain.mjs';

export class RequestBroker {
    constructor({
        routeWbFetch,
        routeAuthorization,
        waitForTransition,
        createRequestId = randomUUID,
        defaultTimeout = REQUEST_TIMEOUT_MS,
    }) {
        this.routeWbFetch = routeWbFetch;
        this.routeAuthorization = routeAuthorization;
        this.waitForTransition = waitForTransition;
        this.createRequestId = createRequestId;
        this.defaultTimeout = defaultTimeout;
    }

    pendingRequests = new Map();
    pendingAuthorizations = new Map();
    inFlightFetches = new Map();

    get activeRequestCount() {
        return this.pendingRequests.size;
    }

    rejectPendingRequests(message) {
        this.#rejectAll(this.pendingRequests, message);
    }

    rejectPendingAuthorizations(message) {
        this.#rejectAll(this.pendingAuthorizations, message);
    }

    resolveFetch(requestId, response, { includeRequestId = false } = {}) {
        const pending = this.#take(this.pendingRequests, requestId);
        if (!pending) return false;
        pending.resolve(includeRequestId ? { ...response, requestId } : response);
        return true;
    }

    rejectFetch(requestId, error) {
        const pending = this.#take(this.pendingRequests, requestId);
        if (!pending) return false;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        return true;
    }

    resolveAuthorization(requestId, authorization) {
        const pending = this.#take(this.pendingAuthorizations, requestId);
        if (!pending) return false;
        pending.resolve(authorization);
        return true;
    }

    rejectAuthorization(requestId, error) {
        const pending = this.#take(this.pendingAuthorizations, requestId);
        if (!pending) return false;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        return true;
    }

    requestWbFetch(url, timeout = this.defaultTimeout, authorizationId) {
        if (typeof authorizationId !== 'string' || authorizationId.length === 0) {
            return Promise.reject(new Error('A signed browser-job authorization is required'));
        }
        if (!isAllowedWbUrl(url)) {
            return Promise.reject(new Error('Only approved Wildberries internal URLs are allowed'));
        }
        const dedupeKey = `${authorizationId}\n${url}\n${timeout}`;
        const existing = this.inFlightFetches.get(dedupeKey);
        if (existing) return existing;

        const request = (async () => {
            await this.waitForTransition(timeout);
            return this.#createPending(this.pendingRequests, timeout, `WB request timed out after ${timeout} ms`, (requestId) =>
                this.routeWbFetch({ requestId, url, timeout, authorizationId })
            );
        })();
        this.inFlightFetches.set(dedupeKey, request);
        void request.then(
            () => this.inFlightFetches.delete(dedupeKey),
            () => this.inFlightFetches.delete(dedupeKey)
        );
        return request;
    }

    requestAuthorization(token, timeout = this.defaultTimeout) {
        return this.#createPending(
            this.pendingAuthorizations,
            timeout,
            `Browser job authorization timed out after ${timeout} ms`,
            (requestId) => this.routeAuthorization({ requestId, token })
        );
    }

    #createPending(collection, timeout, timeoutMessage, route) {
        return new Promise((resolve, reject) => {
            const requestId = this.createRequestId();
            const timer = setTimeout(() => {
                collection.delete(requestId);
                reject(new Error(timeoutMessage));
            }, timeout);
            collection.set(requestId, { resolve, reject, timer });
            try {
                route(requestId);
            } catch (error) {
                clearTimeout(timer);
                collection.delete(requestId);
                reject(error);
            }
        });
    }

    #take(collection, requestId) {
        const pending = collection.get(requestId);
        if (!pending) return null;
        collection.delete(requestId);
        clearTimeout(pending.timer);
        return pending;
    }

    #rejectAll(collection, message) {
        for (const [requestId, pending] of collection) {
            clearTimeout(pending.timer);
            pending.reject(new Error(message));
            collection.delete(requestId);
        }
    }
}
