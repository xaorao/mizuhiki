/*
 * Mizuhiki form embed. Plain browser script, no dependencies.
 *
 * Answers are encrypted inside the form, on the respondent's device. The form
 * runs in its own frame from the Mizuhiki site, so the page around it cannot
 * read what people type.
 *
 * Attribute contract
 *
 * 1. Standard (inline). Put this where the form should appear:
 *      <div data-mizuhiki-inline="https://SITE/@name/f/slug" data-height="560"></div>
 *      <script src="https://SITE/embed.js" async></script>
 *    data-height   pixels, 300 to 1200 (default 560). Width is always 100%.
 *    data-title    optional accessible title for the frame (default "Form").
 *
 * 2. Popup, slider and side tab. One script tag:
 *      <script src="https://SITE/embed.js" data-mizuhiki-form="https://SITE/@name/f/slug"
 *              data-mode="popup" data-label="Open the form" data-color="#c2300f" async></script>
 *    data-mode     "popup" (centred window), "slider" (panel from the right) or
 *                  "sidetab" (a tab fixed to the right edge that opens the slider).
 *                  Popup and slider put a button where the script tag is.
 *    data-label    button text, up to 24 characters.
 *    data-color    button colour as #rrggbb. The text turns white or ink, whichever reads better.
 *
 * 3. Your own button or link:
 *      <button data-mizuhiki-open="https://SITE/@name/f/slug" data-mode="slider">Talk to me</button>
 *
 * Rules: a form address must be https, or on the same site as the page. Other
 * addresses are ignored. The frame address gets ?embed=1 so the form hides its
 * own page chrome. On screens under 640 px the popup and slider fill the screen.
 * Motion is off when the visitor asks for reduced motion.
 *
 * JavaScript:
 *    window.MizuhikiEmbed.open(url, { mode: "popup" | "slider" })  -> { close } or null
 *    window.MizuhikiEmbed.mount(element)                            -> true if mounted
 *    window.MizuhikiEmbed.sideTab(url, { label, color })            -> { remove } or null
 *    window.MizuhikiEmbed.close()                                   closes an open popup or slider
 *    window.MizuhikiEmbed.scan()                                    picks up elements added later
 */
(function () {
  "use strict";

  if (window.MizuhikiEmbed) {
    window.MizuhikiEmbed.scan();
    return;
  }

  var PREFIX = "mzk-";
  var INK = "#2b2340";
  var DEFAULT_COLOR = "#c2300f";
  var DEFAULT_LABEL = "Open the form";
  var HEX = /^#[0-9a-f]{6}$/i;
  var reduced = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var current = null;

  /** An https form address (or one on this same site), with embed=1. Anything else: null. */
  function formUrl(raw) {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    var u;
    try {
      u = new URL(raw.trim(), window.location.href);
    } catch {
      return null;
    }
    if (u.username || u.password) return null;
    if (u.protocol !== "https:" && u.origin !== window.location.origin) return null;
    u.searchParams.set("embed", "1");
    return u.href;
  }

  function color(raw) {
    return typeof raw === "string" && HEX.test(raw.trim()) ? raw.trim().toLowerCase() : DEFAULT_COLOR;
  }
  function label(raw) {
    var t = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    return (t || DEFAULT_LABEL).slice(0, 24);
  }
  function luminance(hex) {
    var n = parseInt(hex.slice(1), 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      var c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  /** White text when it reaches 4.5:1 on the colour, otherwise ink. */
  function textOn(hex) {
    return 1.05 / (luminance(hex) + 0.05) >= 4.5 ? "#ffffff" : INK;
  }

  var CSS =
    "." +
    PREFIX +
    "launch{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 24px;" +
    "border:2.5px solid " +
    INK +
    ";border-radius:999px;box-shadow:0 4px 0 " +
    INK +
    ";font:800 16px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;" +
    "cursor:pointer;transition:transform .12s ease,box-shadow .12s ease;margin:0;}" +
    "." +
    PREFIX +
    "launch:hover{transform:translateY(-1px);}" +
    "." +
    PREFIX +
    "launch:active{transform:translateY(3px);box-shadow:0 1px 0 " +
    INK +
    ";}" +
    "." +
    PREFIX +
    "launch:focus-visible,." +
    PREFIX +
    "tab:focus-visible,." +
    PREFIX +
    "close:focus-visible{outline:3px solid #1f2d6b;outline-offset:3px;}" +
    "." +
    PREFIX +
    "inline{display:block;width:100%;border:0;border-radius:16px;background:transparent;}" +
    "." +
    PREFIX +
    "overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(43,35,64,0);transition:background .24s ease;}" +
    "." +
    PREFIX +
    "overlay." +
    PREFIX +
    "open{background:rgba(43,35,64,.55);}" +
    "." +
    PREFIX +
    "dialog{position:absolute;background:#fff;overflow:hidden;box-shadow:0 18px 48px rgba(43,35,64,.35);" +
    "transition:transform .28s cubic-bezier(.2,.8,.2,1),opacity .24s ease;opacity:0;}" +
    "." +
    PREFIX +
    "popup ." +
    PREFIX +
    "dialog{left:50%;top:50%;width:min(880px,calc(100vw - 48px));height:min(720px,calc(100vh - 48px));" +
    "border-radius:24px;border:2.5px solid " +
    INK +
    ";transform:translate(-50%,-46%) scale(.97);}" +
    "." +
    PREFIX +
    "popup." +
    PREFIX +
    "open ." +
    PREFIX +
    "dialog{transform:translate(-50%,-50%);opacity:1;}" +
    "." +
    PREFIX +
    "slider ." +
    PREFIX +
    "dialog{top:0;right:0;height:100%;width:min(520px,100vw);border-left:2.5px solid " +
    INK +
    ";transform:translateX(100%);opacity:1;}" +
    "." +
    PREFIX +
    "slider." +
    PREFIX +
    "open ." +
    PREFIX +
    "dialog{transform:none;}" +
    "." +
    PREFIX +
    "frame{display:block;width:100%;height:100%;border:0;background:#fff8ef;}" +
    "." +
    PREFIX +
    "close{position:absolute;top:12px;right:12px;z-index:1;width:40px;height:40px;border-radius:50%;border:2.5px solid " +
    INK +
    ";" +
    "background:#fff;color:" +
    INK +
    ";font:700 22px/1 system-ui,sans-serif;cursor:pointer;display:grid;place-items:center;padding:0;}" +
    "." +
    PREFIX +
    "tab{position:fixed;right:0;top:50%;z-index:2147482999;transform:translateY(-50%) rotate(180deg);writing-mode:vertical-rl;" +
    "padding:18px 10px;border:2.5px solid " +
    INK +
    ";border-left:0;border-radius:0 14px 14px 0;font:800 15px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;" +
    "cursor:pointer;box-shadow:-3px 0 0 " +
    INK +
    ";margin:0;}" +
    "@media (max-width:640px){." +
    PREFIX +
    "popup ." +
    PREFIX +
    "dialog,." +
    PREFIX +
    "slider ." +
    PREFIX +
    "dialog{left:0;top:0;right:0;bottom:0;" +
    "width:100%;height:100%;border:0;border-radius:0;transform:translateY(24px);}" +
    "." +
    PREFIX +
    "popup." +
    PREFIX +
    "open ." +
    PREFIX +
    "dialog,." +
    PREFIX +
    "slider." +
    PREFIX +
    "open ." +
    PREFIX +
    "dialog{transform:none;}}" +
    "@media (prefers-reduced-motion:reduce){." +
    PREFIX +
    "overlay,." +
    PREFIX +
    "dialog,." +
    PREFIX +
    "launch{transition:none!important;}}";

  function styles() {
    if (document.getElementById(PREFIX + "style")) return;
    var st = document.createElement("style");
    st.id = PREFIX + "style";
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function frame(src, title, extraClass) {
    var f = document.createElement("iframe");
    f.src = src;
    f.title = title;
    f.className = extraClass;
    f.setAttribute("allow", "clipboard-write");
    f.setAttribute("loading", "lazy");
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    return f;
  }

  function close() {
    if (!current) return;
    var c = current;
    current = null;
    document.removeEventListener("keydown", c.onKey, true);
    c.overlay.classList.remove(PREFIX + "open");
    document.documentElement.style.overflow = c.overflow;
    var gone = function () {
      if (c.overlay.parentNode) c.overlay.parentNode.removeChild(c.overlay);
    };
    if (reduced && reduced.matches) gone();
    else setTimeout(gone, 300);
    if (c.opener && c.opener.isConnected && typeof c.opener.focus === "function") c.opener.focus();
  }

  function open(url, opts) {
    var src = formUrl(url);
    if (!src) return null;
    var mode = opts && opts.mode === "slider" ? "slider" : "popup";
    styles();
    close();

    var overlay = document.createElement("div");
    overlay.className = PREFIX + "overlay " + PREFIX + mode;
    var dialog = document.createElement("div");
    dialog.className = PREFIX + "dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Form");
    var x = document.createElement("button");
    x.type = "button";
    x.className = PREFIX + "close";
    x.setAttribute("aria-label", "Close the form");
    x.textContent = "×";
    var f = frame(src, "Form", PREFIX + "frame");
    f.setAttribute("loading", "eager");
    dialog.appendChild(x);
    dialog.appendChild(f);
    overlay.appendChild(dialog);

    var onKey = function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab") {
        // Keep focus in the dialog: the close button and the form frame.
        var a = document.activeElement;
        if (a !== x && a !== f) {
          e.preventDefault();
          x.focus();
        } else if (a === x && e.shiftKey) {
          e.preventDefault();
          f.focus();
        }
      }
    };
    x.addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    current = {
      overlay: overlay,
      onKey: onKey,
      opener: document.activeElement,
      overflow: document.documentElement.style.overflow,
    };
    document.addEventListener("keydown", onKey, true);
    document.documentElement.style.overflow = "hidden";
    document.body.appendChild(overlay);
    // Next frame, so the entrance transition runs.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.classList.add(PREFIX + "open");
      });
    });
    x.focus();
    return { close: close };
  }

  function mount(el) {
    if (!el || !el.getAttribute) return false;
    var src = formUrl(el.getAttribute("data-mizuhiki-inline"));
    if (!src) return false;
    styles();
    var h = parseInt(el.getAttribute("data-height") || "", 10);
    if (!(h >= 300 && h <= 1200)) h = 560;
    var t = (el.getAttribute("data-title") || "Form").slice(0, 120);
    var f = frame(src, t, PREFIX + "inline");
    f.style.height = h + "px";
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(f);
    el.setAttribute("data-mizuhiki-mounted", "");
    return true;
  }

  function paint(btn, hex) {
    btn.style.background = hex;
    btn.style.color = textOn(hex);
  }

  function sideTab(url, opts) {
    if (!formUrl(url)) return null;
    styles();
    var b = document.createElement("button");
    b.type = "button";
    b.className = PREFIX + "tab";
    b.textContent = label(opts && opts.label);
    paint(b, color(opts && opts.color));
    b.setAttribute("aria-haspopup", "dialog");
    b.addEventListener("click", function () {
      open(url, { mode: "slider" });
    });
    document.body.appendChild(b);
    return {
      remove: function () {
        if (current) close();
        if (b.parentNode) b.parentNode.removeChild(b);
      },
    };
  }

  function launcher(script) {
    script.setAttribute("data-mizuhiki-done", "");
    var url = script.getAttribute("data-mizuhiki-form");
    if (!formUrl(url)) return;
    var mode = script.getAttribute("data-mode");
    var opts = { label: script.getAttribute("data-label"), color: script.getAttribute("data-color") };
    if (mode === "sidetab") {
      sideTab(url, opts);
      return;
    }
    styles();
    var b = document.createElement("button");
    b.type = "button";
    b.className = PREFIX + "launch";
    b.textContent = label(opts.label);
    paint(b, color(opts.color));
    b.setAttribute("aria-haspopup", "dialog");
    var m = mode === "slider" ? "slider" : "popup";
    b.addEventListener("click", function () {
      open(url, { mode: m });
    });
    if (script.parentNode && script.parentNode !== document.head) script.parentNode.insertBefore(b, script.nextSibling);
    else document.body.appendChild(b);
  }

  function scan() {
    var i;
    var inl = document.querySelectorAll("[data-mizuhiki-inline]:not([data-mizuhiki-mounted])");
    for (i = 0; i < inl.length; i++) mount(inl[i]);
    var trig = document.querySelectorAll("[data-mizuhiki-open]:not([data-mizuhiki-bound])");
    for (i = 0; i < trig.length; i++) {
      (function (el) {
        el.setAttribute("data-mizuhiki-bound", "");
        el.addEventListener("click", function (e) {
          var u = el.getAttribute("data-mizuhiki-open");
          if (!formUrl(u)) return;
          e.preventDefault();
          open(u, { mode: el.getAttribute("data-mode") === "slider" ? "slider" : "popup" });
        });
      })(trig[i]);
    }
    var scripts = document.querySelectorAll("script[data-mizuhiki-form]:not([data-mizuhiki-done])");
    for (i = 0; i < scripts.length; i++) launcher(scripts[i]);
  }

  window.MizuhikiEmbed = Object.freeze({ open: open, mount: mount, sideTab: sideTab, close: close, scan: scan });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
