/**
 * Edge fades for cut-off scroll areas.
 *
 * A scroll container gets `omt-fade-top` only when it is scrolled away from
 * its top, and `omt-fade-bottom` only when more content remains below. The
 * classes switch a `mask-image` gradient on and off, so a short list has no
 * faded edge at all.
 */

import { useEffect, type RefObject } from "react";

const EDGE_TOLERANCE = 1;

/** Update both fade classes from the current scroll position. */
export function refreshEdgeFade(element: HTMLElement): void {
  const canScroll = element.scrollHeight > element.clientHeight + EDGE_TOLERANCE;
  const atTop = element.scrollTop <= EDGE_TOLERANCE;
  const atBottom =
    element.scrollTop + element.clientHeight >= element.scrollHeight - EDGE_TOLERANCE;

  element.classList.toggle("omt-fade-top", canScroll && !atTop);
  element.classList.toggle("omt-fade-bottom", canScroll && !atBottom);
}

/**
 * Keep the edge-fade classes of a scroll container up to date.
 *
 * @param ref - the scroll container.
 * @param revision - any value that changes when the content changes (items,
 *                   expanded row, selected step, …).
 */
export function useEdgeFade(
  ref: RefObject<HTMLElement | null>,
  revision?: unknown,
): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const update = (): void => refreshEdgeFade(element);
    update();

    element.addEventListener("scroll", update, { passive: true });

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(element);
    }

    let mutationObserver: MutationObserver | undefined;
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(update);
      mutationObserver.observe(element, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }

    return () => {
      element.removeEventListener("scroll", update);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [ref, revision]);
}
