export type CollectPhase = "idle" | "pending" | "scanning";

export type CollectProgress = {
  running: boolean;
  phase: CollectPhase;
  currentAgent: string;
  message: string;
};

export function createCollectProgress(): CollectProgress {
  return { running: false, phase: "idle", currentAgent: "", message: "" };
}

export function markCollectPending(progress: CollectProgress, message = "准备扫描本地记忆…"): void {
  progress.running = true;
  progress.phase = "pending";
  progress.currentAgent = "";
  progress.message = message;
}

export function snapshotCollect(progress: CollectProgress): CollectProgress {
  return {
    running: progress.running,
    phase: progress.phase,
    currentAgent: progress.currentAgent,
    message: progress.message,
  };
}
