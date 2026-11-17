// "Follow the bottom" for the transcript (Claude Code behaviour): while the reader is at the
// bottom, new content keeps the view pinned there without jumps; scrolling up stops following
// (and shows "jump to latest"); reaching the bottom again, sending a message or the jump button
// resumes it. Pure logic; ChatView wires it to the scroll container and a ResizeObserver.

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Within this many pixels of the end counts as "at the bottom". */
export const FOLLOW_THRESHOLD = 32;

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

export function isAtBottom(m: ScrollMetrics, threshold = FOLLOW_THRESHOLD): boolean {
  return distanceFromBottom(m) <= threshold;
}

export class ScrollFollower {
  following = true;
  private lastTop = 0;
  private programmatic = false;

  /** A scroll event. Moving up (by the reader) stops following; reaching the end resumes it. */
  onScroll(m: ScrollMetrics): boolean {
    if (this.programmatic) {
      this.programmatic = false;
      this.lastTop = m.scrollTop;
      return this.following;
    }
    const movedUp = m.scrollTop < this.lastTop - 1;
    this.lastTop = m.scrollTop;
    if (isAtBottom(m)) this.following = true;
    else if (movedUp) this.following = false;
    return this.following;
  }

  /** A wheel / key gesture towards the top stops following at once (before the scroll lands). */
  onUserScrollUp(): void {
    this.following = false;
  }

  /**
   * Content or viewport changed size. Returns the scrollTop to apply (pinned to the end while
   * following), or null to leave the view where it is.
   */
  onResize(m: ScrollMetrics): number | null {
    if (!this.following) return null;
    const target = Math.max(0, m.scrollHeight - m.clientHeight);
    if (Math.abs(target - m.scrollTop) < 1) return null;
    this.programmatic = true;
    this.lastTop = target;
    return target;
  }

  /** Sending a message or the jump button: follow again. */
  resume(): void {
    this.following = true;
  }
}

/** The floating "jump to latest" button shows while the reader is away from the end. */
export function showJumpToLatest(following: boolean, m: ScrollMetrics | null): boolean {
  if (following || !m) return false;
  return distanceFromBottom(m) > FOLLOW_THRESHOLD * 4;
}
