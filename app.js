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
  function formatRelativeTime(iso) {
    var then = Date.parse(iso);
    if (isNaN(then)) return "";
    var diffMin = Math.round((Date.now() - then) / 60000);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return diffMin + " minute" + (diffMin === 1 ? "" : "s") + " ago";

    var diffHours = Math.round(diffMin / 60);
    if (diffHours < 24) return diffHours + " hour" + (diffHours === 1 ? "" : "s") + " ago";

    var date = new Date(then);
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (
      date.getDate() === yesterday.getDate() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getFullYear() === yesterday.getFullYear()
    ) {
      return "Yesterday";
    }

    var diffDays = Math.round(diffHours / 24);
    if (diffDays < 7) return diffDays + " day" + (diffDays === 1 ? "" : "s") + " ago";

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function updateRelativeTimes() {
    cards.forEach(function (card) {
      var el = card.querySelector("[data-relative-time]");
      if (el) el.textContent = formatRelativeTime(card.dataset.updatedAt);
    });
  }

  updateRelativeTimes();
  setInterval(updateRelativeTimes, 60000);
})();
