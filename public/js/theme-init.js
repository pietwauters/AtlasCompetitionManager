'use strict';
(function () {
  const t = localStorage.getItem('atlas-theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
})();
