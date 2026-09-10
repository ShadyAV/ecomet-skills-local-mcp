const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TRANSIENT_RELEASE_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const isTransientReleaseError = error => TRANSIENT_RELEASE_ERRORS.has(error?.code);
const LOCK_RELEASE_ATTEMPTS = 3;
const LOCK_RELEASE_RETRY_MS = 25;
const LOCK_RELEASE_DEFER_MS = 1000;
const LOCK_RELEASE_MAX_DEFER_MS = 60_000;
// Bound background filesystem work even when many storage roots are unavailable.
const LOCK_RELEASE_BACKGROUND_BATCH = 8;
// A bounded sweep can advance successfully without discharging all ownership.
export const OWNED_RELEASE_PENDING = Symbol('owned release pending');

export const releaseOwnedLock = async release => {
    for (let attempt = 0; ; attempt += 1) {
        try { return await release(); }
        catch (error) {
            if (!isTransientReleaseError(error) || attempt + 1 >= LOCK_RELEASE_ATTEMPTS) throw error;
            await delay(LOCK_RELEASE_RETRY_MS);
        }
    }
};

// Only completed critical sections enter this registry. Unknown owners are never
// deletion authority. Unrestricted streams of completed jobs use a generic sweep
// per root. Failed setup may retain exact job accounting when admission to that
// root is blocked until cleanup finishes.
export const createOwnedLockReleaseTracker = () => {
    const pendingLockReleases = new Map();
    let timer;
    let timerDue;
    let running = false;
    const schedule = () => {
        if (!pendingLockReleases.size) {
            if (timer) clearTimeout(timer);
            timer = undefined;
            timerDue = undefined;
        } else if (!running) {
            let earliest = Infinity;
            for (const pending of pendingLockReleases.values()) earliest = Math.min(earliest, pending.nextAt);
            // Recovery delays are elapsed time, independent of wall-clock correction.
            const due = Math.max(performance.now() + LOCK_RELEASE_DEFER_MS, earliest);
            if (timer && timerDue <= due) return;
            if (timer) clearTimeout(timer);
            timerDue = due;
            const onTimer = () => {
                // Native timers can wake slightly before a fractional monotonic
                // deadline. Keep that deadline instead of treating an empty early
                // wake as a completed batch and adding a whole retry interval.
                const remaining = due - performance.now();
                if (remaining > 0) {
                    timer = setTimeout(onTimer, Math.ceil(remaining));
                    timer.unref();
                    return;
                }
                timer = undefined;
                timerDue = undefined;
                running = true;
                return (async () => {
                    // One attempt per key per tick; FIFO rotation prevents an
                    // inaccessible root from starving later cleanup obligations.
                    const batch = [];
                    for (const entry of pendingLockReleases) {
                        if (entry[1].nextAt > performance.now()) continue;
                        batch.push(entry);
                        if (batch.length === LOCK_RELEASE_BACKGROUND_BATCH) break;
                    }
                    for (const [key, pending] of batch) {
                        if (pendingLockReleases.get(key) !== pending) continue;
                        try { await retry(key, pending, false); } catch { /* Keep exact ownership for recovery. */ }
                    }
                })().finally(() => { running = false; schedule(); });
            };
            timer = setTimeout(onTimer, Math.ceil(due - performance.now()));
            timer.unref();
        }
    };
    const retry = (key, pending, immediate = true) => {
        if (pending.inFlight) {
            const inFlight = pending.inFlight;
            if (!immediate || pending.immediate) return inFlight;
            // Joining a single background attempt must not discard the caller's
            // short transient-retry guarantee. Exact cleanup stays serialized.
            return inFlight.catch(error => {
                if (!isTransientReleaseError(error)) throw error;
                return retry(key, pending, true);
            });
        }
        const version = pending.version;
        pending.immediate = immediate;
        pending.inFlight = Promise.resolve().then(async () => {
            try {
                const outcome = immediate ? await releaseOwnedLock(() => pending.release(version)) : await pending.release(version);
                pending.retryMs = LOCK_RELEASE_DEFER_MS;
                pending.nextAt = performance.now() + pending.retryMs;
                if (outcome !== OWNED_RELEASE_PENDING && pendingLockReleases.get(key) === pending && version === pending.version) pendingLockReleases.delete(key);
            } catch (error) {
                // Faults back off per owner; a fresh root or successful sweep
                // must not inherit another unavailable root's delay.
                if (!immediate) pending.retryMs = Math.min(pending.retryMs * 2, LOCK_RELEASE_MAX_DEFER_MS);
                pending.nextAt = performance.now() + pending.retryMs;
                throw error;
            } finally {
                pending.inFlight = undefined;
                if (pendingLockReleases.get(key) === pending) {
                    pendingLockReleases.delete(key);
                    pendingLockReleases.set(key, pending);
                }
                // EIO/EROFS and unknown failures can also clear later. They do
                // not get short retries, but still get bounded automatic recovery.
                schedule();
            }
        });
        return pending.inFlight;
    };
    const register = (identity, release, key = identity) => {
        let pending = pendingLockReleases.get(identity);
        // Keep the sweep closure: replacing it would discard its cursor and
        // cycle version, so repeated registrations could prevent completion.
        if (pending) pending.version++;
        else {
            pending = { key, release, version: 0, inFlight: undefined, immediate: false,
                retryMs: LOCK_RELEASE_DEFER_MS, nextAt: performance.now() + LOCK_RELEASE_DEFER_MS };
            pendingLockReleases.set(identity, pending);
        }
        return pending;
    };
    return {
        defer(key, release) { register(key, release); schedule(); },
        async retryPending(key) {
            // Snapshot: retry rotates failed entries to the FIFO tail. Settle
            // other owners before surfacing failure; retain every failed owner.
            let failure;
            for (const [identity, pending] of [...pendingLockReleases]) {
                if (pending.key === key && pendingLockReleases.get(identity) === pending) {
                    try { await retry(identity, pending); } catch (error) { failure ??= error; }
                }
            }
            if (failure) throw failure;
        },
        async release(key, release) {
            // A successor can acquire an emptied directory while its predecessor
            // still retries removal. Each owner's closure and promise must survive;
            // only defer() coalesces stateful sweeps for the same storage root.
            const identity = {};
            await retry(identity, register(identity, release, key));
        },
    };
};
