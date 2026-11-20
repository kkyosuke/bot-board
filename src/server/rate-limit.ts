import { type RateLimit } from "@cloudflare/workers-types";

import { DomainError } from "@/domain";

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface RequestRateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

export function createCloudflareRateLimiter(
  binding: RateLimit,
  retryAfterSeconds = 60,
): RequestRateLimiter {
  return {
    async check(key: string): Promise<RateLimitResult> {
      const outcome = await binding.limit({ key });
      return {
        allowed: outcome.success,
        retryAfterSeconds,
      };
    },
  };
}

export function createMemoryRateLimiter(options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}): RequestRateLimiter {
  const buckets = new Map<string, number[]>();
  const nowFn = options.now ?? (() => Date.now());

  return {
    check(key: string): Promise<RateLimitResult> {
      const now = nowFn();
      const cutoff = now - options.windowMs;

      // Prune stale buckets opportunistically to prevent unbounded memory growth
      if (buckets.size > 128) {
        for (const [bucketKey, timestamps] of buckets.entries()) {
          const remaining = timestamps.filter((ts) => ts > cutoff);
          if (remaining.length === 0) {
            buckets.delete(bucketKey);
          } else {
            buckets.set(bucketKey, remaining);
          }
        }
      }

      const existing = buckets.get(key) ?? [];
      const active = existing.filter((ts) => ts > cutoff);

      if (active.length >= options.limit) {
        const oldest = active[0] ?? now;
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
        buckets.set(key, active);
        return Promise.resolve({ allowed: false, retryAfterSeconds });
      }

      active.push(now);
      buckets.set(key, active);
      return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
    },
  };
}

export async function enforceRateLimit(
  limiter: RequestRateLimiter | undefined,
  key: string,
): Promise<void> {
  if (limiter === undefined) {
    return;
  }
  const outcome = await limiter.check(key);
  if (!outcome.allowed) {
    throw new DomainError("RATE_LIMITED", "Too many requests. Retry later.", true, {
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
}
