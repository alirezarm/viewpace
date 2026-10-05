/**
 * Captured caption responses the page hook can replay to a content script that (re)loaded late.
 * Like all transient data, it is kept for the current video only: a capture for a new video
 * drops the ones for other videos. The newest capture is never dropped.
 */
export class ReplayBuffer<T> {
  private entries: { videoId: string | null; msg: T }[] = [];

  constructor(private readonly max = 8) {}

  /** `videoId` is the video the capture belongs to; null if unknown (keeps the others). */
  push(msg: T, videoId: string | null): void {
    if (videoId !== null) this.entries = this.entries.filter((e) => e.videoId === videoId || e.videoId === null);
    this.entries.push({ videoId, msg });
    if (this.entries.length > this.max) this.entries.shift();
  }

  all(): T[] {
    return this.entries.map((e) => e.msg);
  }
}
