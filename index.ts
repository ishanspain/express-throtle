import type { Request, Response, RequestHandler } from 'express';

type ThrottleKey = string | number | null | undefined;

export type ThrottleOptions = {
    delayAfter?: number;
    delayMs?: number;
    maxDelayMs?: number | null;
    keyGenerator?: (req: Request, res: Response) => ThrottleKey;
};

const nextStartTimes = new Map<string, {
    reqCount: number;
    nextAvailableAt: number;
}>();

export function ct({
    delayAfter = 3,
    delayMs = 2000,
    maxDelayMs = null,
    keyGenerator = (req) => req.ip,
}: ThrottleOptions = {}): RequestHandler {
    if (!Number.isFinite(delayAfter) || delayAfter < 0) {
        throw new TypeError('delayAfter must be a non-negative number');
    }

    if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new TypeError('delayMs must be a non-negative number');
    }

    if (maxDelayMs !== null && (!Number.isFinite(maxDelayMs) || maxDelayMs < 0)) {
        throw new TypeError('maxDelayMs must be null or non-negative');
    }

    return (req, res, next) => {
        let id;

        try {
            id = String(keyGenerator(req, res) ?? req.ip);
        } catch (error) {
            return next(error);
        }

        const now = Date.now();
        const state = nextStartTimes.get(id) ?? {
            reqCount: 0,
            nextAvailableAt: now,
        };

        const shouldDelay = state.reqCount >= delayAfter || state.nextAvailableAt > now;

        let delay = 0;

        if (shouldDelay) {
            const scheduledAt = Math.max(now, state.nextAvailableAt) + delayMs;

            delay = scheduledAt - now;
            state.nextAvailableAt = scheduledAt;
        } else {
            state.nextAvailableAt = Math.max(now, state.nextAvailableAt);
        }

        if (maxDelayMs !== null && delay > maxDelayMs) {
            return res.status(429).json({
                error: 'Maximum delay reached',
                retryAfterMs: delay,
            });
        }

        state.reqCount += 1;
        nextStartTimes.set(id, state);

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let middlewareStarted = false;

        const settle = () => {
            if (settled) return;
            settled = true;

            // Prevent next() from running after a disconnected request.
            if (!middlewareStarted && timer !== undefined) {
                clearTimeout(timer);
            }

            state.reqCount -= 1;

            if (state.reqCount <= 0) {
                nextStartTimes.delete(id);
            }
        };

        res.once('finish', settle);
        res.once('close', settle);

        const proceed = () => {
            if (settled) return;

            middlewareStarted = true;
            next();
        };

        if (delay > 0) {
            timer = setTimeout(proceed, delay);
            return;
        }

        proceed();
    };
}
