/*
  Shitalpati engagement widget — drop-in JS for the AI-generated static
  site (index/category/province/detail/video pages built by the n8n
  pipeline). Talks to the Flask panel's public API (app/blueprints/public_api.py),
  which is CORS-open and requires no login.

  SETUP (one-time):
  1. Set PANEL_BASE_URL below to wherever the Flask panel is reachable
     (e.g. "https://panel.yourdomain.com" or an ngrok/Cloud Run URL —
     it must be a URL the *public* internet can reach, not localhost).
  2. Include this file on every generated page, once, right before </body>:
       <script src="/assets/engagement-widget.js"></script>
     Easiest place to add that tag: n8n's "Build Final Header" or footer
     code node, since those already concatenate a fixed string onto every
     page — append `<script src="/assets/engagement-widget.js"></script>`
     there instead of relying on the AI layout prompt to include it
     (AI-generated HTML won't reliably keep exact <script> tags/IDs).
  3. On detail pages, add these two fixed containers into the page HTML
     (again in the code node that assembles the detail page, not the AI
     prompt) so the widget has somewhere to render into:
       <div id="engagement-reactions" data-article-id="{{news_id}}"></div>
       <div id="engagement-comments" data-article-id="{{news_id}}"></div>
     Replace {{news_id}} with the actual news_id value already available
     in that code node (e.g. `item.news_id`).
  4. On the index/category/etc. pages, add a search box anywhere in the
     header markup:
       <div id="engagement-search"></div>
  5. Ad `<img>` tags that should be tracked need `data-ad-id="<id>"`:
       <img src="..." data-ad-id="{{ad.id}}">
     (also update the ad-fetch Postgres node/query to use the
     `active`/`start_date`/`end_date` columns — see get_active_ads() in
     db.py — so paused/expired ads stop being fetched in the first place.)
*/
(function () {
  "use strict";

  var PANEL_BASE_URL = "https://test-shittalpati.vercel.app/"; // <-- set this
  var API = PANEL_BASE_URL + "/api/public";

  function post(path, body) {
    return fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }
  function get(path) {
    return fetch(API + path).then(function (r) { return r.json(); });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---- 1. page view tracking -------------------------------------------
  function trackView() {
    var articleEl = document.querySelector("[data-article-id]");
    var articleId = articleEl ? articleEl.getAttribute("data-article-id") : null;
    var pageType = articleId ? "article" : "index";
    post("/track-view", {
      page_type: pageType,
      article_id: articleId,
      ref_slug: window.location.pathname,
    });
  }

  // ---- 2. ad impression/click tracking ---------------------------------
  function trackAds() {
    var seen = {};
    document.querySelectorAll("[data-ad-id]").forEach(function (el) {
      var adId = el.getAttribute("data-ad-id");
      if (!seen[adId]) {
        seen[adId] = true;
        post("/ads/" + adId + "/impression");
      }
      el.addEventListener("click", function () {
        post("/ads/" + adId + "/click");
      });
    });
  }

  // ---- 3. reactions -------------------------------------------------
  var REACTIONS = [
    { type: "like", emoji: "\ud83d\udc4d" },
    { type: "love", emoji: "\u2764\ufe0f" },
    { type: "wow", emoji: "\ud83d\ude2e" },
    { type: "sad", emoji: "\ud83d\ude22" },
    { type: "angry", emoji: "\ud83d\ude21" },
  ];

  function initReactions() {
    var box = document.getElementById("engagement-reactions");
    if (!box) return;
    var articleId = box.getAttribute("data-article-id");
    if (!articleId) return;

    function render(counts) {
      box.innerHTML = REACTIONS.map(function (r) {
        var n = counts[r.type] || 0;
        return '<button class="eng-reaction-btn" data-type="' + r.type + '" ' +
          'style="border:1px solid #ddd;border-radius:20px;background:#fff;padding:6px 12px;margin:2px;cursor:pointer;font-size:14px;">' +
          r.emoji + " " + n + "</button>";
      }).join("");
      box.querySelectorAll(".eng-reaction-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          btn.disabled = true;
          post("/reactions/" + articleId, { type: btn.getAttribute("data-type") }).then(function () {
            return get("/reactions/" + articleId);
          }).then(function (data) {
            if (data.ok) render(data.reactions);
          });
        });
      });
    }

    get("/reactions/" + articleId).then(function (data) {
      render(data.ok ? data.reactions : {});
    });
  }

  // ---- 4. comments ----------------------------------------------------
  function initComments() {
    var box = document.getElementById("engagement-comments");
    if (!box) return;
    var articleId = box.getAttribute("data-article-id");
    if (!articleId) return;

    box.innerHTML =
      '<h3>Comments</h3>' +
      '<div id="eng-comment-list">Loading\u2026</div>' +
      '<form id="eng-comment-form" style="margin-top:12px;">' +
      '  <input type="text" id="eng-comment-name" placeholder="Your name" required ' +
      '    style="display:block;width:100%;max-width:400px;padding:8px;margin-bottom:6px;border:1px solid #ccc;border-radius:6px;">' +
      '  <textarea id="eng-comment-body" placeholder="Write a comment\u2026" required rows="3" ' +
      '    style="display:block;width:100%;max-width:400px;padding:8px;margin-bottom:6px;border:1px solid #ccc;border-radius:6px;"></textarea>' +
      '  <button type="submit" style="padding:8px 16px;border:none;border-radius:6px;background:#4f8cff;color:#fff;cursor:pointer;">Post comment</button>' +
      '  <span id="eng-comment-status" style="margin-left:10px;font-size:13px;color:#666;"></span>' +
      '</form>';

    function loadList() {
      get("/comments/" + articleId).then(function (data) {
        var list = document.getElementById("eng-comment-list");
        if (!data.ok || !data.comments.length) {
          list.innerHTML = "<p style=\"color:#888;\">No comments yet \u2014 be the first.</p>";
          return;
        }
        list.innerHTML = data.comments.map(function (c) {
          return '<div style="border-bottom:1px solid #eee;padding:10px 0;">' +
            '<strong>' + esc(c.author_name) + '</strong> ' +
            '<span style="color:#999;font-size:12px;">' + new Date(c.created_at).toLocaleDateString() + '</span>' +
            '<p style="margin:4px 0 0;">' + esc(c.body) + '</p></div>';
        }).join("");
      });
    }

    document.getElementById("eng-comment-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("eng-comment-name").value.trim();
      var body = document.getElementById("eng-comment-body").value.trim();
      var status = document.getElementById("eng-comment-status");
      if (!name || !body) return;
      status.textContent = "Posting\u2026";
      post("/comments/" + articleId, { name: name, body: body }).then(function (data) {
        status.textContent = data.ok ? (data.message || "Posted.") : (data.error || "Error posting comment.");
        if (data.ok) {
          document.getElementById("eng-comment-body").value = "";
        }
      });
    });

    loadList();
  }

  // ---- 5. search ------------------------------------------------------
  function initSearch() {
    var box = document.getElementById("engagement-search");
    if (!box) return;
    box.innerHTML =
      '<div style="position:relative;max-width:320px;">' +
      '  <input type="text" id="eng-search-input" placeholder="Search news\u2026" ' +
      '    style="width:100%;padding:8px 12px;border:1px solid #ccc;border-radius:20px;">' +
      '  <div id="eng-search-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;' +
      '    border:1px solid #ddd;border-radius:8px;margin-top:4px;max-height:340px;overflow-y:auto;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,.1);"></div>' +
      '</div>';

    var input = document.getElementById("eng-search-input");
    var results = document.getElementById("eng-search-results");
    var timer = null;

    input.addEventListener("input", function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) {
        results.style.display = "none";
        return;
      }
      timer = setTimeout(function () {
        get("/search?q=" + encodeURIComponent(q)).then(function (data) {
          if (!data.ok || !data.results.length) {
            results.innerHTML = '<div style="padding:10px;color:#888;">No results.</div>';
            results.style.display = "block";
            return;
          }
          results.innerHTML = data.results.map(function (r) {
            var title = r.title || r.titlenp || "Untitled";
            var href = "/news/" + esc(r.slug) + ".html"; // adjust to your actual detail-page URL pattern
            return '<a href="' + href + '" style="display:block;padding:10px;border-bottom:1px solid #eee;color:#222;text-decoration:none;">' +
              esc(title) + '<div style="font-size:11px;color:#999;">' + esc(r.category || "") + '</div></a>';
          }).join("");
          results.style.display = "block";
        });
      }, 300);
    });

    document.addEventListener("click", function (e) {
      if (!box.contains(e.target)) results.style.display = "none";
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    trackView();
    trackAds();
    initReactions();
    initComments();
    initSearch();
  });
})();
