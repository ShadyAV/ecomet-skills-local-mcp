import { randomUUID } from 'node:crypto';

import { AUTHORIZATION_SCOPE_MAX_MS, MAX_ACTIVE_AUTHORIZATION_SCOPES, REQUEST_TIMEOUT_MS } from './config.mjs';
import { ToolExecutionError } from './tool-errors.mjs';
import { isAllowedWbUrl } from './wb-domain.mjs';

export class RequestBroker {
    constructor({
        routeWbFetch,
        routeAuthorization,
        waitForTransition,
        createRequestId = randomUUID,
        defaultTimeout = REQUEST_TIMEOUT_MS,
        authorizationScopeMaxMs = AUTHORIZATION_SCOPE_MAX_MS,
        maxActiveAuthorizationScopes = MAX_ACTIVE_AUTHORIZATION_SCOPES,
    }) {
        this.routeWbFetch = routeWbFetch;
        this.routeAuthorization = routeAuthorization;
        this.waitForTransition = waitForTransition;
        this.createRequestId = createRequestId;
        this.defaultTimeout = defaultTimeout;
        this.authorizationScopeMaxMs = authorizationScopeMaxMs;
        this.maxActiveAuthorizationScopes = maxActiveAuthorizationScopes;
    }

    pendingRequests = new Map();
    pendingAuthorizations = new Map();
    activeAuthorizationScopes = new Map();
    inFlightFetches = new Map();

    get activeRequestCount() {
        return this.pendingRequests.size + this.pendingAuthorizations.size + this.activeAuthorizationScopes.size;
    }

    rejectPendingRequests(message) {
        this.#rejectAll(this.pendingRequests, message);
    }

    rejectPendingAuthorizations(message) {
        this.#rejectAll(this.pendingAuthorizations, message);
        for (const requestId of this.activeAuthorizationScopes.keys()) {
            this.#releaseAuthorizationScope(requestId, false);
        }
    }

    invalidateAuthorizationWork() {
        const error = this.#reauthorizationRequired();
        this.#rejectAll(this.pendingRequests, error);
        this.#rejectAll(this.pendingAuthorizations, error);
        for (const requestId of this.activeAuthorizationScopes.keys()) {
            this.#releaseAuthorizationScope(requestId, false);
        }
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

    requestWbFetch(url, timeout = this.defaultTimeout, authorizationId, authorizationScopeId) {
        if (typeof authorizationId !== 'string' || authorizationId.length === 0) {
            return Promise.reject(new Error('A signed browser-job authorization is required'));
        }
        if (!isAllowedWbUrl(url)) {
            return Promise.reject(new Error('Only approved Wildberries internal URLs are allowed'));
        }
        const authorizationScope =
            typeof authorizationScopeId === 'string' ? this.activeAuthorizationScopes.get(authorizationScopeId) : undefined;
        if (typeof authorizationScopeId === 'string' && !authorizationScope) {
            return Promise.reject(this.#reauthorizationRequired());
        }
        if (authorizationScope && !this.#authorizationScopeIsActive(authorizationScopeId, authorizationScope)) {
            return Promise.reject(this.#reauthorizationRequired());
        }
        if (authorizationScope && authorizationScope.authorizationId !== authorizationId) {
            return Promise.reject(this.#reauthorizationRequired());
        }
        const dedupeKey = `${authorizationScopeId || ''}\n${authorizationId}\n${url}\n${timeout}`;
        const existing = this.inFlightFetches.get(dedupeKey);
        if (existing) return existing;

        const request = (async () => {
            if (!authorizationScope) {
                await this.waitForTransition(timeout);
            } else if (!this.#authorizationScopeIsActive(authorizationScopeId, authorizationScope)) {
                throw this.#reauthorizationRequired();
            }
            return this.#createPending(this.pendingRequests, timeout, `WB request timed out after ${timeout} ms`, (requestId) =>
                this.routeWbFetch({ requestId, url, timeout, authorizationId, authorizationScopeId })
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
        if (this.pendingAuthorizations.size + this.activeAuthorizationScopes.size >= this.maxActiveAuthorizationScopes) {
            return Promise.reject(
                new ToolExecutionError(
                    'AUTHORIZATION_SCOPE_CAPACITY_EXCEEDED',
                    'Too many browser job authorization scopes are active.',
                    'local',
                    true
                )
            );
        }
        return this.#createPending(
            this.pendingAuthorizations,
            timeout,
            `Browser job authorization timed out after ${timeout} ms`,
            (requestId) => this.routeAuthorization({ requestId, token }),
            (authorization, requestId, routeResult) => {
                const routeBinding =
                    typeof routeResult === 'function'
                        ? { release: routeResult }
                        : routeResult && typeof routeResult === 'object'
                          ? routeResult
                          : {};
                const authorizationScope = {
                    authorizationId: authorization?.authorizationId,
                    isRouteActive: routeBinding.isActive,
                    releaseRoute: routeBinding.release,
                    expiryTimer: setTimeout(() => this.#releaseAuthorizationScope(requestId, true), this.authorizationScopeMaxMs),
                };
                authorizationScope.expiryTimer.unref?.();
                this.activeAuthorizationScopes.set(requestId, authorizationScope);
                return {
                    authorization,
                    requestWbFetch: (url, fetchTimeout = this.defaultTimeout) =>
                        this.requestWbFetch(url, fetchTimeout, authorization?.authorizationId, requestId),
                    isActive: () => this.#authorizationScopeIsActive(requestId, authorizationScope),
                    release: () => this.#releaseAuthorizationScope(requestId, true),
                };
            }
        );
    }

    #authorizationScopeIsActive(requestId, authorizationScope) {
        if (this.activeAuthorizationScopes.get(requestId) !== authorizationScope) return false;
        if (typeof authorizationScope.isRouteActive !== 'function') return true;
        let routeActive = false;
        try {
            routeActive = authorizationScope.isRouteActive() === true;
        } catch {
            routeActive = false;
        }
        if (routeActive) return true;
        this.#releaseAuthorizationScope(requestId, true);
        return false;
    }

    #createPending(collection, timeout, timeoutMessage, route, transform = (value) => value) {
        return new Promise((resolve, reject) => {
            const requestId = this.createRequestId();
            const timer = setTimeout(() => {
                collection.delete(requestId);
                reject(new Error(timeoutMessage));
            }, timeout);
            const pending = {
                resolve: (value) => {
                    try {
                        resolve(transform(value, requestId, pending.routeResult));
                    } catch (error) {
                        reject(error);
                    }
                },
                reject,
                timer,
                routeResult: undefined,
            };
            collection.set(requestId, pending);
            try {
                pending.routeResult = route(requestId);
            } catch (error) {
                clearTimeout(timer);
                collection.delete(requestId);
                reject(error);
            }
        });
    }

    #releaseAuthorizationScope(requestId, notifyRoute) {
        const authorizationScope = this.activeAuthorizationScopes.get(requestId);
        if (!authorizationScope) return false;
        this.activeAuthorizationScopes.delete(requestId);
        clearTimeout(authorizationScope.expiryTimer);
        if (notifyRoute && typeof authorizationScope.releaseRoute === 'function') {
            authorizationScope.releaseRoute();
        }
        return true;
    }

    #reauthorizationRequired() {
        return new ToolExecutionError(
            'BROWSER_JOB_REAUTHORIZATION_REQUIRED',
            'Browser job authorization must be acquired again after the bridge connection changed.',
            'authorization',
            true
        );
    }

    #take(collection, requestId) {
        const pending = collection.get(requestId);
        if (!pending) return null;
        collection.delete(requestId);
        clearTimeout(pending.timer);
        return pending;
    }

    #rejectAll(collection, errorOrMessage) {
        for (const [requestId, pending] of collection) {
            clearTimeout(pending.timer);
            pending.reject(errorOrMessage instanceof Error ? errorOrMessage : new Error(errorOrMessage));
            collection.delete(requestId);
        }
    }
}
