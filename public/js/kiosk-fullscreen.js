'use strict';
// Full-screen affordance for kiosk display pages. Browsers only allow
// requestFullscreen() from inside a direct user-gesture handler, so entry
// can never be automatic on page load — this shows a small, unobtrusive
// one-time hint and requests full screen on the first tap/click anywhere
// on the page. Reappears if full screen is exited (e.g. Escape key), so
// the operator can re-enter without reloading.
function setupKioskFullscreen() {
  const hint = document.createElement('div');
  hint.textContent = 'Tap anywhere for full screen';
  Object.assign(hint.style, {
    position: 'fixed', bottom: '1rem', right: '1rem', zIndex: 9999,
    padding: '.5rem .9rem', borderRadius: '.4rem',
    background: 'rgba(0,0,0,.65)', color: '#fff',
    fontSize: '.85rem', cursor: 'pointer', userSelect: 'none',
  });
  document.body.appendChild(hint);

  function enter() {
    const el  = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el).catch(() => {});
  }
  document.addEventListener('click', enter);

  function sync() {
    hint.style.display = document.fullscreenElement ? 'none' : 'block';
  }
  document.addEventListener('fullscreenchange', sync);
  sync();
}
