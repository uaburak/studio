import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_CENTER_WIDTH,
  navigateByGesture,
  runMenuCommand,
} from "../../src/renderer/components/shell/app-shell.tsx";
import { usePostsStore } from "../../src/renderer/features/posts/store.ts";
import {
  mouseButtonDirection,
  navKeyTakenByCanvas,
  noSwipeAt,
  noteCanvasNavKey,
  SWIPE_DISTANCE,
  SWIPE_GESTURE_GAP,
  SwipeDetector,
  swipeBlockedAt,
  type WheelSample,
} from "../../src/renderer/lib/nav-gestures.ts";
import {
  parseRoute,
  type Route,
  routeKey,
  useAppStore,
} from "../../src/renderer/state/app-store.ts";

const app = () => useAppStore.getState();
const at = () => ({ route: routeKey(app().route), post: app().post });

beforeEach(() => {
  useAppStore.setState({ route: { kind: "new" }, post: null, back: [], forward: [] });
  usePostsStore.setState({ opened: null, selectedId: null });
});

describe("routes", () => {
  it("round-trips the brands list and a brand's section", () => {
    const routes: Route[] = [
      { kind: "brands" },
      { kind: "brand", id: "b1", tab: "products" },
      { kind: "brand", id: "b1", tab: "general" },
      { kind: "posts" },
      { kind: "calendar" },
      { kind: "media" },
      { kind: "conversation", id: "c1" },
    ];
    for (const route of routes) expect(parseRoute(routeKey(route))).toEqual(route);
    // A brand without a section is the default one (Marka Kiti).
    expect(routeKey({ kind: "brand", id: "b1" })).toBe(
      routeKey({ kind: "brand", id: "b1", tab: "kit" }),
    );
    // Sessions saved before sections were routes.
    expect(parseRoute("brand:b1")).toEqual({ kind: "brand", id: "b1" });
    expect(parseRoute("brand:b1/unknown")).toEqual({ kind: "brand", id: "b1/unknown" });
  });
});

describe("history", () => {
  it("steps back and forward through chats, pages, brands and brand sections", () => {
    app().navigate({ kind: "conversation", id: "c1" });
    app().navigate({ kind: "posts" });
    app().navigate({ kind: "calendar" });
    app().navigate({ kind: "media" });
    app().navigate({ kind: "brands" });
    app().navigate({ kind: "brand", id: "b1" });
    app().navigate({ kind: "brand", id: "b1", tab: "products" });
    app().navigate({ kind: "brand", id: "b1", tab: "products" }); // same place: no step
    expect(app().back).toHaveLength(7);

    const visited: string[] = [];
    while (app().back.length > 0) {
      app().goBack();
      visited.push(routeKey(app().route));
    }
    expect(visited).toEqual([
      "brand:b1/kit",
      "brands",
      "media",
      "calendar",
      "posts",
      "c:c1",
      "new",
    ]);
    expect(app().forward).toHaveLength(7);
    app().goForward();
    app().goForward();
    expect(app().route).toEqual({ kind: "posts" });
    // A new place drops what was ahead.
    app().navigate({ kind: "brands" });
    expect(app().forward).toEqual([]);
    app().goForward(); // nothing ahead: stays
    expect(app().route).toEqual({ kind: "brands" });
  });

  it("replaces the current step when asked", () => {
    app().navigate({ kind: "posts" });
    app().navigate({ kind: "calendar" }, { replace: true });
    expect(app().route).toEqual({ kind: "calendar" });
    app().goBack();
    expect(app().route).toEqual({ kind: "new" });
  });

  it("opening a post is a step: back closes it, forward reopens it", () => {
    app().navigate({ kind: "posts" });
    usePostsStore.getState().open("p1");
    expect(at()).toEqual({ route: "posts", post: "p1" });

    app().goBack();
    expect(at()).toEqual({ route: "posts", post: null });
    expect(usePostsStore.getState().opened).toBeNull();

    app().goForward();
    expect(at()).toEqual({ route: "posts", post: "p1" });
    expect(usePostsStore.getState().opened).toMatchObject({ contentId: "p1", tab: "post" });

    // Closing it (✕ / Esc) right after opening steps back, so forward reopens it again.
    usePostsStore.getState().close();
    expect(at()).toEqual({ route: "posts", post: null });
    expect(app().forward[0]).toMatchObject({ post: "p1" });
  });

  it("going elsewhere closes the post; back brings it back open", () => {
    app().navigate({ kind: "calendar" });
    usePostsStore.getState().open("p2", { origin: { x: 1, y: 2, width: 3, height: 4 } });
    app().navigate({ kind: "media" });
    expect(at()).toEqual({ route: "media", post: null });
    expect(usePostsStore.getState().opened).toBeNull();

    app().goBack();
    expect(at()).toEqual({ route: "calendar", post: "p2" });
    expect(usePostsStore.getState().opened?.contentId).toBe("p2");

    // Clicking the same sidebar row while a post is open closes it as a step.
    app().navigate({ kind: "calendar" });
    expect(at()).toEqual({ route: "calendar", post: null });
    app().goBack();
    expect(at()).toEqual({ route: "calendar", post: "p2" });
  });

  it("a post opened from another post closes back onto the first", () => {
    app().navigate({ kind: "posts" });
    usePostsStore.getState().open("p1");
    usePostsStore.getState().open("p1-copy");
    usePostsStore.getState().close();
    // The step before p1-copy was p1 (not "no post"), so closing is a new step.
    expect(at()).toEqual({ route: "posts", post: null });
    app().goBack();
    expect(at()).toEqual({ route: "posts", post: "p1-copy" });
  });

  it("forgets a deleted post", () => {
    app().navigate({ kind: "posts" });
    usePostsStore.getState().open("gone");
    app().navigate({ kind: "media" });
    app().forgetPost("gone");
    app().goBack();
    expect(at()).toEqual({ route: "posts", post: null });
    expect(app().back.map((l) => l.post)).not.toContain("gone");
  });
});

describe("gestures", () => {
  const sample = (deltaX: number, timeStamp: number, over: Partial<WheelSample> = {}) => ({
    deltaX,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    timeStamp,
    ...over,
  });

  it("reads mouse buttons 4 / 5", () => {
    expect(mouseButtonDirection({ button: 3 })).toBe("back");
    expect(mouseButtonDirection({ button: 4 })).toBe("forward");
    expect(mouseButtonDirection({ button: 0 })).toBeNull();
    expect(mouseButtonDirection({ button: 2 })).toBeNull();
  });

  /** Wheel event times: 16 ms apart, or after a pause. */
  function clock() {
    let t = 0;
    return {
      tick: () => {
        t += 16;
        return t;
      },
      pause: () => {
        t += SWIPE_GESTURE_GAP + 10;
        return t;
      },
    };
  }

  it("turns one sideways two-finger swipe into one step", () => {
    const swipe = new SwipeDetector();
    const time = clock();
    // Fingers to the right: negative deltaX → back, once, momentum included.
    const back = Array.from({ length: 20 }, () => swipe.wheel(sample(-30, time.tick())));
    expect(back.filter(Boolean)).toEqual(["back"]);
    // Not far enough after a pause: nothing.
    expect(swipe.wheel(sample(SWIPE_DISTANCE / 2, time.pause()))).toBeNull();
    // A new gesture the other way: forward.
    time.pause();
    const forward = Array.from({ length: 8 }, () => swipe.wheel(sample(40, time.tick())));
    expect(forward.filter(Boolean)).toEqual(["forward"]);
  });

  it("ignores vertical scrolls, pinches and blocked targets", () => {
    const swipe = new SwipeDetector();
    const time = clock();
    // Mostly vertical: a scroll, even if it drifts sideways later.
    expect(swipe.wheel(sample(5, time.tick(), { deltaY: 60 }))).toBeNull();
    for (let i = 0; i < 10; i++) expect(swipe.wheel(sample(-60, time.tick()))).toBeNull();
    time.pause();
    for (let i = 0; i < 10; i++)
      expect(swipe.wheel(sample(-60, time.tick(), { ctrlKey: true }))).toBeNull();
    time.pause();
    for (let i = 0; i < 10; i++) expect(swipe.wheel(sample(-60, time.tick()), true)).toBeNull();
  });

  it("leaves text fields, sideways scrollers and marked areas alone", () => {
    document.body.innerHTML = `
      <div id="plain"><span id="text">x</span></div>
      <input id="field" />
      <div data-no-swipe><span id="marked">x</span></div>
      <div id="scroller" style="overflow-x: auto"><span id="inside">x</span></div>`;
    const scroller = document.getElementById("scroller") as HTMLElement;
    Object.defineProperty(scroller, "scrollWidth", { value: 900 });
    Object.defineProperty(scroller, "clientWidth", { value: 300 });
    expect(swipeBlockedAt(document.getElementById("text"))).toBe(false);
    expect(swipeBlockedAt(document.getElementById("field"))).toBe(true);
    expect(swipeBlockedAt(document.getElementById("marked"))).toBe(true);
    expect(swipeBlockedAt(document.getElementById("inside"))).toBe(true);
    expect(swipeBlockedAt(null)).toBe(false);
  });

  it("keeps one step when a swipe arrives twice (wheel and the window's swipe event)", () => {
    app().navigate({ kind: "posts" });
    app().navigate({ kind: "calendar" });
    app().navigate({ kind: "media" });
    const t0 = performance.now() - 5_000;
    expect(navigateByGesture("back", t0)).toBe(true);
    expect(navigateByGesture("back", t0 + 300)).toBe(false);
    expect(app().route).toEqual({ kind: "calendar" });
    expect(navigateByGesture("forward", t0 + 1_000)).toBe(true);
    expect(app().route).toEqual({ kind: "media" });
    // The window's swipe event, well after the last gesture.
    runMenuCommand("swipe-back");
    expect(app().route).toEqual({ kind: "calendar" });
    runMenuCommand("back");
    expect(app().route).toEqual({ kind: "posts" });
    runMenuCommand("forward");
    expect(app().route).toEqual({ kind: "calendar" });
    expect(MIN_CENTER_WIDTH).toBeGreaterThan(0);
  });

  it("never goes back for a key or a swipe the post canvas kept (E8)", () => {
    document.body.innerHTML = `<div data-no-swipe><canvas id="canvas"></canvas></div><button id="b">x</button>`;
    expect(noSwipeAt(document.getElementById("canvas"))).toBe(true);
    expect(noSwipeAt(document.getElementById("b"))).toBe(false);
    app().navigate({ kind: "posts" });
    app().navigate({ kind: "calendar" });
    // ⌘[ used on the canvas (Wecra's send backward): the menu's Geri that carries it does nothing.
    const used = new KeyboardEvent("keydown", { key: "[", metaKey: true, cancelable: true });
    used.preventDefault();
    noteCanvasNavKey(used);
    expect(navKeyTakenByCanvas()).toBe(true);
    runMenuCommand("back");
    expect(app().route).toEqual({ kind: "calendar" });
    // A while later (or a key nobody used) Geri goes back again.
    expect(navKeyTakenByCanvas(performance.now() + 1_000)).toBe(false);
    noteCanvasNavKey(new KeyboardEvent("keydown", { key: "[", metaKey: true }));
    runMenuCommand("back");
    expect(app().route).toEqual({ kind: "posts" });
  });
});
