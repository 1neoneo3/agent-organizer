export interface LatestRequestTracker {
  start: () => number;
  isCurrent: (requestId: number) => boolean;
}

export function createLatestRequestTracker(): LatestRequestTracker {
  let currentRequestId = 0;

  return {
    start() {
      currentRequestId += 1;
      return currentRequestId;
    },
    isCurrent(requestId) {
      return requestId === currentRequestId;
    },
  };
}
