// Anti-clickjacking for GitHub Pages (which cannot send frame-ancestors). Loaded first in <head>, must stay synchronous and dependency-free.
// Top-level use is always fine. Framing is allowed only by our own sites (the Arcade Room embeds Zombies and Drag Strip);
// anything else gets a blank page and tries to break out.
(function () {
  if (window.top === window.self) return;
  var OK = { 'https://vwfest.github.io': 1, 'https://vwfestmemecoin.com': 1, 'https://www.vwfestmemecoin.com': 1 };
  var allowed = false;
  try { allowed = !!OK[window.top.location.origin]; } catch (e) {                  // cross-origin parent: read-only hints
    var ao = window.location.ancestorOrigins;
    if (ao && ao.length) { allowed = true; for (var i = 0; i < ao.length; i++) if (!OK[ao[i]]) allowed = false; }
    else { try { allowed = !!OK[new URL(document.referrer).origin]; } catch (e2) { allowed = false; } }
  }
  if (allowed) return;
  try { document.documentElement.style.display = 'none'; } catch (e) {}
  try { window.stop(); } catch (e) {}
  try { window.top.location.replace(window.self.location.href); } catch (e) {}
})();
