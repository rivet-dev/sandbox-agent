interface RepoLockState {
  locked: boolean;
  waiters: Array<() => void>;
}

const repoLocks = new Map<string, RepoLockState>();

async function acquireRepoLock(repoPath: string): Promise<() => void> {
  let state = repoLocks.get(repoPath);
  if (!state) {
    state = { locked: false, waiters: [] };
    repoLocks.set(repoPath, state);
  }

  if (!state.locked) {
    state.locked = true;
    return () => releaseRepoLock(repoPath, state);
  }

  await new Promise<void>((resolve) => {
    state!.waiters.push(resolve);
  });

  return () => releaseRepoLock(repoPath, state!);
}

function releaseRepoLock(repoPath: string, state: RepoLockState): void {
  const next = state.waiters.shift();
  if (next) {
    next();
    return;
  }

  state.locked = false;
  repoLocks.delete(repoPath);
}

export async function withRepoGitLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireRepoLock(repoPath);
  try {
    return await fn();
  } finally {
    release();
  }
}
