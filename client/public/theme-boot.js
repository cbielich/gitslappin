// Runs before the app loads so the saved theme and zoom show from the first paint. Only the exact values "dark" and "light", and a zoom from 0.8 to 1.5, are ever applied.
(function () {
  try {
    // First load after the rename from GitGit: copy each old "gitgit-*" key to its "gitslappin-*" name when the new one is missing. The old keys stay.
    var OLD = 'gitgit-';
    var NEW = 'gitslappin-';
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    keys.forEach(function (k) {
      if (k && k.indexOf(OLD) === 0 && localStorage.getItem(NEW + k.slice(OLD.length)) === null) {
        var v = localStorage.getItem(k);
        if (v !== null) localStorage.setItem(NEW + k.slice(OLD.length), v);
      }
    });
    var t =localStorage.getItem('gitslappin-theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    var z = Number(localStorage.getItem('gitslappin-zoom'));
    if (z >= 0.8 && z <= 1.5) document.documentElement.style.zoom = String(Math.round(z * 10) / 10);
  } catch (e) {
    // storage blocked: the defaults stay
  }
})();
