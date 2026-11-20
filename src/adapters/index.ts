import { DomainError } from "@/domain";

export interface BoundedModelStepOptions {
  readonly timeoutMs: number;
  readonly leaseRemainingMs: number;
}

export function assertModelTimeoutWithinLease(options: BoundedModelStepOptions): void {
  if (options.timeoutMs <= 0 || options.leaseRemainingMs <= 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Timeout and lease duration must be positive.",
      false,
    );
  }
  if (options.timeoutMs >= options.leaseRemainingMs) {
    throw new DomainError(
      "LEASE_CONFLICT",
      "Model step timeout must be strictly shorter than remaining WorkLease TTL.",
      true,
    );
  }
}
