'use strict';
function navApp() {
  return {
    activeComps: [],

    async initNav() {
      this._injectFullscreen();
      this._injectManualLink();
      await Promise.all([ this.loadActiveComps(), this._injectUserWidget() ]);
      setInterval(() => this.loadActiveComps(), 20000);
    },

    _injectManualLink() {
      const navRight = document.querySelector('header > div[style*="margin-left"]');
      if (!navRight) return;
      const a = document.createElement('a');
      a.href = '/manual/index.html';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Manual';
      a.style.cssText = 'opacity:.65;font-size:.85rem';
      navRight.insertBefore(a, navRight.firstChild);
    },

    _injectFullscreen() {
      const header = document.querySelector('header');
      if (!header) return;
      const btn = document.createElement('button');
      btn.title = 'Toggle fullscreen';
      btn.textContent = '⛶';
      btn.style.cssText = 'background:none;border:none;color:inherit;font-size:1.1rem;cursor:pointer;padding:.2rem .5rem;margin-left:.5rem;opacity:.8';

      const setIcon = () => { btn.textContent = document.fullscreenElement ? '⊡' : '⛶'; };

      btn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
          sessionStorage.setItem('fs', '1');
        } else {
          document.exitFullscreen();
          sessionStorage.removeItem('fs');
        }
      });
      document.addEventListener('fullscreenchange', () => {
        setIcon();
        if (!document.fullscreenElement) sessionStorage.removeItem('fs');
      });
      header.appendChild(btn);

      // Restore fullscreen when navigating between pages.
      // requestFullscreen is allowed here because the page load was triggered by a user gesture.
      if (sessionStorage.getItem('fs') === '1') {
        document.documentElement.requestFullscreen().catch(() => sessionStorage.removeItem('fs'));
      }
    },

    async _injectUserWidget() {
      const navRight = document.querySelector('header > div[style*="margin-left"]');
      if (!navRight) return;

      const data = await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}));

      const sep = document.createElement('span');
      sep.style.cssText = 'width:1px;height:1rem;background:rgba(255,255,255,.2);flex-shrink:0';
      navRight.appendChild(sep);

      if (!data.authenticated) {
        const a = document.createElement('a');
        a.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
        a.textContent = 'Sign in';
        a.style.cssText = 'opacity:.65;font-size:.85rem';
        navRight.appendChild(a);
        return;
      }

      const roleLabel = { admin: 'Admin', director: 'Director', assistant: 'Assistant', referee: 'Referee' };
      const pill = document.createElement('span');
      pill.style.cssText = 'font-size:.78rem;opacity:.65;white-space:nowrap';
      pill.textContent = `${data.username} · ${roleLabel[data.role] || data.role}`;
      navRight.appendChild(pill);

      const btn = document.createElement('button');
      btn.textContent = 'Sign out';
      btn.style.cssText = 'background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);' +
        'color:inherit;font-size:.78rem;cursor:pointer;padding:.2rem .5rem;border-radius:4px;margin:0';
      btn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        location.href = '/login.html';
      });
      navRight.appendChild(btn);
    },

    async loadActiveComps() {
      const all = await fetch('/api/competitions/active').then(r => r.json()).catch(() => []);
      // Deduplicate by competition ID; prefer active phase over pending over none.
      const rank = s => s === 'active' ? 2 : s === 'pending' ? 1 : 0;
      const seen = new Map();
      for (const c of all) {
        const existing = seen.get(c.id);
        if (!existing || rank(c.phase_status) > rank(existing.phase_status)) seen.set(c.id, c);
      }
      this.activeComps = [...seen.values()];
    },

    phaseLink(comp) {
      if (comp.phase_type === 'pool') return `/phase.html?id=${comp.phase_id}`;
      if (comp.phase_type === 'de')   return `/de.html?id=${comp.phase_id}`;
      return `/competition-detail.html?id=${comp.id}`;
    },

    compLabel(comp) {
      if (!comp.phase_type) return comp.name;
      const type = comp.phase_type === 'pool' ? 'Pool' : 'DE';
      return `${comp.name} (${type})`;
    },
  };
}
