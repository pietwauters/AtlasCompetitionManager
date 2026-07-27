'use strict';
// Continuous vertical auto-scroll for kiosk waiting-room displays — a
// slowly-turning cylinder, never a reset-to-top.
//
// Deliberately NOT a CSS @keyframes loop: a 0%->100% infinite animation
// visibly stutters for a frame right where it restarts on most browsers.
// Instead this drives the transform directly via requestAnimationFrame and
// wraps the scroll position with subtraction (position -= contentHeight)
// rather than ever resetting to 0 — since the content is duplicated once,
// the pixels on screen at that wrap are identical to the pixels one frame
// before, so there is nothing for the eye to catch.
//
// Call again whenever rendered content changes (data refresh, resize).
// Scroll position is kept on the track element (track.__kioskState) and
// deliberately NOT reset on a refresh — only re-measured/clamped to the
// (possibly new) content height — because callers poll every ~20s while a
// full scroll cycle normally takes much longer: resetting to 0 on every
// poll meant the list never scrolled far enough to show its later rows at
// all. The frame loop itself also isn't restarted if it's already running,
// so a refresh never causes a visible jump.
function setupKioskScroll(viewport, track, content, pxPerSecond) {
  pxPerSecond = pxPerSecond || 35;
  const state = track.__kioskState || (track.__kioskState = { position: 0, running: false });

  track.querySelectorAll('.kiosk-clone').forEach(el => el.remove());

  const contentHeight  = content.getBoundingClientRect().height;
  const viewportHeight = viewport.clientHeight;

  if (!contentHeight || contentHeight <= viewportHeight) {
    state.running = false;
    track.style.transform = '';
    return;
  }

  const clone = content.cloneNode(true);
  clone.classList.add('kiosk-clone');
  clone.setAttribute('aria-hidden', 'true');
  track.appendChild(clone);

  state.contentHeight = contentHeight;
  state.pxPerSecond   = pxPerSecond;
  state.position      = state.position % contentHeight;

  if (state.running) return; // frame loop is already ticking and will pick up the new state

  state.running = true;
  let lastTs = null;
  function frame(ts) {
    if (!state.running) return;
    if (lastTs != null) {
      state.position += (ts - lastTs) / 1000 * state.pxPerSecond;
      if (state.position >= state.contentHeight) state.position -= state.contentHeight;
      track.style.transform = `translateY(${-state.position}px)`;
    }
    lastTs = ts;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
