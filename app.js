// Vanilla JS, no build step, no dependencies. Everything it touches is
// already rendered in the HTML — this only adds filtering/search/copy
// interactivity on top of static content.
(function () {
  "use strict";

  var chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));
  var teamFilter = document.getElementById("team-filter");
  var searchBox = document.getElementById("search-box");
  var cards = Array.prototype.slice.call(document.querySelectorAll(".card"));
  var emptyMessage = document.getElementById("empty-message");

  var state = { filter: "latest", team: "", search: "" };

  function cardMatchesFilter(card, chip) {
    var key = chip.dataset.filter;
    if (key === "latest") return true;
    if (key === "breaking") {
      return Number(card.dataset.importance) >= Number(chip.dataset.minImportance || 9);
    }
    if (key === "rumor") {
      return card.dataset.rumor === "true";
    }
    var categories = (chip.dataset.categories || "").split(",").filter(Boolean);
    if (categories.length === 0) return true;
    return categories.indexOf(card.dataset.category) !== -1;
  }

  function applyFilters() {
    var activeChip = chips.find(function (c) {
      return c.dataset.filter === state.filter;
    });
    var searchTerm = state.search.trim().toLowerCase();
    var visibleCount = 0;

    cards.forEach(function (card) {
      var matchesFilter = activeChip ? cardMatchesFilter(card, activeChip) : true;
      var matchesTeam = !state.team || (card.dataset.teams || "").split(",").indexOf(state.team) !== -1;
      var matchesSearch = !searchTerm || (card.dataset.search || "").indexOf(searchTerm) !== -1;
      var visible = matchesFilter && matchesTeam && matchesSearch;
      card.hidden = !visible;
      if (visible) visibleCount++;
    });

    if (emptyMessage) emptyMessage.hidden = visibleCount > 0;
  }

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      chips.forEach(function (c) {
        c.classList.remove("active");
      });
      chip.classList.add("active");
      state.filter = chip.dataset.filter;
      applyFilters();
    });
  });
  var defaultChip = chips.find(function (c) {
    return c.dataset.filter === "latest";
  });
  if (defaultChip) defaultChip.classList.add("active");

  if (teamFilter) {
    teamFilter.addEventListener("change", function () {
      state.team = teamFilter.value;
      applyFilters();
    });
  }

  if (searchBox) {
    var debounceHandle;
    searchBox.addEventListener("input", function () {
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(function () {
        state.search = searchBox.value;
        applyFilters();
      }, 200);
    });
  }

  applyFilters();

  // --- Copy for Munch -------------------------------------------------
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var targetId = btn.dataset.copyTarget;
      var textarea = document.getElementById(targetId);
      if (!textarea) return;
      copyText(textarea.value).then(function (ok) {
        var original = btn.textContent;
        btn.textContent = ok ? "Copied ✓" : "Select & copy manually";
        btn.classList.toggle("copied", ok);
        setTimeout(function () {
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 2000);
      });
    });
  });

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return legacyCopy(text);
        }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  // Fallback for contexts without the async Clipboard API (e.g. a page
  // opened directly via file://, which browsers treat as insecure).
  function legacyCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  }

  // --- Live relative timestamps ----------------------------------------
  // Full format: "8 minutes ago" / "1 hour ago" / "Today, 2:46 PM" /
  // "Yesterday, 8:10 PM" / "Aug 21, 2026" — used for each story's main
  // displayed time (latest_published_at).
  function formatRelativeTime(iso) {
    var then = Date.parse(iso);
    if (isNaN(then)) return "";
    var diffMs = Date.now() - then;
    var diffMin = Math.round(diffMs / 60000);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return diffMin + " minute" + (diffMin === 1 ? "" : "s") + " ago";

    var diffHours = diffMs / 3600000;
    if (diffHours < 3) {
      var hrs = Math.round(diffHours);
      return hrs + " hour" + (hrs === 1 ? "" : "s") + " ago";
    }

    var date = new Date(then);
    var now = new Date();
    var timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

    var isToday =
      date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    if (isToday) return "Today, " + timeStr;

    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var isYesterday =
      date.getDate() === yesterday.getDate() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getFullYear() === yesterday.getFullYear();
    if (isYesterday) return "Yesterday, " + timeStr;

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  // Compact format: always "N minute/hour/day(s) ago", no absolute-date
  // fallback — used for the small "UPDATED …" badge and the header's
  // "Last checked …" indicator, where a full date would be overkill.
  function formatShortRelative(iso) {
    var then = Date.parse(iso);
    if (isNaN(then)) return "";
    var diffMin = Math.round((Date.now() - then) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return diffMin + " minute" + (diffMin === 1 ? "" : "s") + " ago";
    var diffHours = Math.round(diffMin / 60);
    if (diffHours < 24) return diffHours + " hour" + (diffHours === 1 ? "" : "s") + " ago";
    var diffDays = Math.round(diffHours / 24);
    return diffDays + " day" + (diffDays === 1 ? "" : "s") + " ago";
  }

  function updateRelativeTimes() {
    document.querySelectorAll("[data-relative-time]").forEach(function (el) {
      if (el.dataset.time) el.textContent = formatRelativeTime(el.dataset.time);
    });
    document.querySelectorAll("[data-relative-time-short]").forEach(function (el) {
      if (el.dataset.time) el.textContent = formatShortRelative(el.dataset.time);
    });
  }

  updateRelativeTimes();
  setInterval(updateRelativeTimes, 60000);

  // --- Freshness / "last successful feed check" indicator ----------------
  // Reads status.json (committed on every successful refresh, whether or
  // not any story content changed) rather than GitHub's Actions API — a
  // same-origin static file is not subject to API rate limits, caching
  // ambiguity, or auth scope questions, and it's written by the same
  // process that actually did the check, so there's no second system that
  // could disagree with it.
  (function setupFreshnessIndicator() {
    var container = document.getElementById("freshness-indicator");
    var label = document.getElementById("freshness-label");
    if (!container || !label) return;

    var DELAYED_AFTER_MINUTES = 30;
    var STALE_AFTER_MINUTES = 60;
    var lastSuccessfulRefresh = null;

    function render() {
      if (!lastSuccessfulRefresh) return;
      var ageMinutes = (Date.now() - Date.parse(lastSuccessfulRefresh)) / 60000;
      var rel = formatShortRelative(lastSuccessfulRefresh);
      container.classList.remove("stale", "delayed");
      if (ageMinutes > STALE_AFTER_MINUTES) {
        label.textContent = "FEED STALE — automatic refresh may not be running (last successful check: " + rel + ")";
        container.classList.add("stale");
      } else if (ageMinutes > DELAYED_AFTER_MINUTES) {
        label.textContent = "FEED MAY BE DELAYED — last successful feed check: " + rel;
        container.classList.add("delayed");
      } else {
        label.textContent = "Last successful feed check: " + rel;
      }
    }

    function fetchStatus() {
      fetch("./status.json", { cache: "no-store" })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (data) {
          if (data && data.last_successful_refresh) {
            lastSuccessfulRefresh = data.last_successful_refresh;
            render();
          } else if (!lastSuccessfulRefresh) {
            label.textContent = "Feed status unavailable";
          }
        })
        .catch(function () {
          if (!lastSuccessfulRefresh) label.textContent = "Feed status unavailable";
        });
    }

    fetchStatus();
    setInterval(render, 60000); // keep the relative time/staleness state ticking
    setInterval(fetchStatus, 5 * 60000); // re-poll periodically for a fresher status.json
  })();
})();
