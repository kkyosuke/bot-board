export interface GuardedMutationOutcome {
  readonly applied: boolean;
  readonly parentChanges: number;
}

export function didParentMutationApply(parentChanges: number): GuardedMutationOutcome {
  return {
    applied: parentChanges === 1,
    parentChanges,
  };
}
