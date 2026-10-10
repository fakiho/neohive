/* Consent-gated Google Analytics (GA4) loader for the Alionix sites.
   GA only loads after the visitor chooses "Accept". The choice is stored under
   the localStorage key 'analytics-consent' (same key the portfolio uses), but
   localStorage is per-origin, so each host prompts once independently.
   Configure per page with <script defer src="..." data-ga-id="G-XXXX">. */
(function () {
  var KEY = 'analytics-consent';
  var el = document.currentScript;
  var GA_ID = el && el.getAttribute('data-ga-id');
  if (!GA_ID) return;

  var returnFocusTo = null;

  function getConsent() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function setConsent(choice) {
    try { localStorage.setItem(KEY, choice); } catch (e) {}
    if (choice === 'accepted') loadGA();
    hideBanner();
  }
  function loadGA() {
    if (window.__gaLoaded) return;
    window.__gaLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
  }

  /* Fire a GA4 event only once analytics consent has been granted. A no-op
     before consent and before gtag has loaded, so it is safe to call anywhere. */
  window.gaEvent = function (name, params) {
    if (!name || getConsent() !== 'accepted') return;
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', name, params || {});
  };

  function hideBanner() {
    var b = document.getElementById('consent-banner');
    if (b && b.parentNode) b.parentNode.removeChild(b);
    if (returnFocusTo && returnFocusTo.isConnected !== false &&
        typeof returnFocusTo.focus === 'function') {
      try { returnFocusTo.focus(); } catch (e) {}
    }
    returnFocusTo = null;
  }
  function showBanner() {
    if (document.getElementById('consent-banner')) return;
    returnFocusTo = document.activeElement;
    var style = document.createElement('style');
    style.textContent =
      '#consent-banner{position:fixed;right:1rem;bottom:1rem;z-index:9999;max-width:22rem;' +
      'padding:1rem 1.1rem;border-radius:14px;background:#16161a;border:1px solid rgba(255,255,255,.12);' +
      'color:#e8e8ea;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.5)}' +
      '#consent-banner p{margin:0 0 .85rem;font-size:.82rem;color:#b9b9c0}' +
      '#consent-banner a{color:#5eead4;text-decoration:underline}' +
      '#consent-banner .consent-actions{display:flex;gap:.5rem}' +
      '#consent-banner button{flex:1;cursor:pointer;border-radius:9px;padding:.5rem .7rem;' +
      'font:inherit;font-size:.82rem;font-weight:600;border:1px solid rgba(255,255,255,.14);' +
      'background:transparent;color:#d5d5db}' +
      '#consent-banner button[data-choice="accepted"]{background:#5eead4;color:#0f0f10;border-color:#5eead4}';
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'consent-banner';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Analytics consent');
    wrap.innerHTML =
      '<p>We use cookies to measure how these sites are used. ' +
      'Accept enables Google Analytics; Essential Only keeps it off. ' +
      '<a href="https://ali.alionix.com/privacy">Privacy policy</a></p>' +
      '<div class="consent-actions">' +
      '<button type="button" data-choice="rejected">Essential Only</button>' +
      '<button type="button" data-choice="accepted">Accept</button>' +
      '</div>';
    wrap.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-choice]') : null;
      if (b) setConsent(b.getAttribute('data-choice'));
    });
    /* Keyboard behaviour for the dialog: keep focus inside it and let Esc
       dismiss it. Esc records 'rejected' (Essential Only) rather than leaving
       the choice unset, so the banner is not shown again on every page. */
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        setConsent('rejected');
        return;
      }
      if (e.key !== 'Tab') return;
      var items = wrap.querySelectorAll('a[href], button:not([disabled])');
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    document.body.appendChild(wrap);
    var firstChoice = wrap.querySelector('[data-choice]');
    if (firstChoice) firstChoice.focus();
  }

  /* One delegated listener turns data attributes into GA4 events:
       <a data-ga-event="outbound_click" data-ga-label="GitHub">
       <a data-ga-event="cta_click" data-ga-label="Explore neoHive" data-ga-location="hero">
     gaEvent() enforces the "accepted only" rule, so no events fire pre-consent. */
  document.addEventListener('click', function (e) {
    var node = e.target && e.target.closest ? e.target.closest('[data-ga-event]') : null;
    if (!node) return;
    var name = node.getAttribute('data-ga-event');
    if (!name) return;
    if (name === 'outbound_click') {
      var link = node.closest('a') || node;
      var label = node.getAttribute('data-ga-label');
      window.gaEvent('outbound_click', {
        link_url: link.href || '',
        link_domain: link.hostname || '',
        link_text: label || (node.textContent || '').trim().slice(0, 100)
      });
    } else {
      var params = {};
      var ctaLabel = node.getAttribute('data-ga-label');
      var ctaLocation = node.getAttribute('data-ga-location');
      if (ctaLabel) params.cta_label = ctaLabel;
      if (ctaLocation) params.cta_location = ctaLocation;
      window.gaEvent(name, params);
    }
  });

  var choice = getConsent();
  if (choice === 'accepted') {
    loadGA();
  } else if (choice === 'rejected') {
    /* stay off */
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showBanner);
  } else {
    showBanner();
  }
})();
