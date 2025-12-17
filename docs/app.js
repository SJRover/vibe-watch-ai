// ===== Required elements =====
const aiForm = document.getElementById("ai-form");
const resultsCard = document.getElementById("results-card");
const resultBody = document.getElementById("result-body");
const resultsSub = document.getElementById("results-sub");

const btnRefresh = document.getElementById("btn-refresh");
const btnSurprise = document.getElementById("btn-surprise");
const moodEl = document.getElementById("mood");
const promptEl = document.getElementById("prompt");

const playlistForm = document.getElementById("playlist-form");
const playlistNameInput = document.getElementById("playlist-name");
const playlistList = document.getElementById("playlist-list");
const playlistItems = document.getElementById("playlist-items");
const activePlaylistTitle = document.getElementById("active-playlist-title");

const btnDeletePlaylist = document.getElementById("btn-delete-playlist");

const btnClear = document.getElementById("btn-clear");
const btnClearLater = document.getElementById("btn-clear-later");
const btnClearWatched = document.getElementById("btn-clear-watched");

const watchLaterList = document.getElementById("watchlater-list");
const watchedList = document.getElementById("watched-list");

const toastEl = document.getElementById("toast");

// Onboarding
const onboardModal = document.getElementById("onboard-modal");
const onboardClose = document.getElementById("onboard-close");

// ===== Keep your old saved data =====
const LS_LIKED = "vibewatch_liked";
const LS_DISLIKED = "vibewatch_disliked";
const LS_PLAYLISTS = "vibewatch_playlists";
const LS_ACTIVE_PLAYLIST = "vibewatch_active_playlist";
const LS_ONBOARDED = "vibewatch_onboarded";
const LS_WATCHLATER = "vibewatch_watchlater";
const LS_WATCHED = "vibewatch_watched";
const LS_PROVIDER_PREFS = "vibewatch_provider_prefs";

let lastItems = [];
let lastPrompt = "";
let lastRefreshToken = "";

// provider filter state
let providerPrefs = loadJson(LS_PROVIDER_PREFS, { include: [], exclude: [] });

// ===== API base (auto local vs live) =====
const IS_LOCAL =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1";

const API_BASE = IS_LOCAL
  ? "http://localhost:3000"
  : "https://vibe-watch-ai.onrender.com";

// ===== Helpers =====
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.hidden = true), 1600);
}
function getRegion() { return "GB"; }
function getLocalHour() { try { return new Date().getHours(); } catch { return null; } }

function normalizeItem(item) {
  return {
    id: item.id,
    title: item.title,
    media_type: item.media_type,
    release_date: item.release_date,
    poster_path: item.poster_path
  };
}
function currentExcludeIds() {
  return (lastItems || []).map(x => x.id);
}

// ===== Likes / dislikes =====
function addToLiked(item) {
  const liked = loadJson(LS_LIKED, []);
  const disliked = loadJson(LS_DISLIKED, []);
  const n = normalizeItem(item);

  saveJson(LS_DISLIKED, disliked.filter(d => String(d.id) !== String(n.id)));

  if (!liked.some(l => String(l.id) === String(n.id))) {
    liked.unshift(n);
    saveJson(LS_LIKED, liked.slice(0, 120));
  }
}
function addToDisliked(item) {
  const liked = loadJson(LS_LIKED, []);
  const disliked = loadJson(LS_DISLIKED, []);
  const n = normalizeItem(item);

  saveJson(LS_LIKED, liked.filter(l => String(l.id) !== String(n.id)));

  if (!disliked.some(d => String(d.id) === String(n.id))) {
    disliked.unshift(n);
    saveJson(LS_DISLIKED, disliked.slice(0, 250));
  }
}

// ===== Playlists =====
function loadPlaylists() { return loadJson(LS_PLAYLISTS, []); }
function savePlaylists(playlists) { saveJson(LS_PLAYLISTS, playlists); }
function getActivePlaylistName() { return localStorage.getItem(LS_ACTIVE_PLAYLIST) || ""; }
function setActivePlaylistName(name) { localStorage.setItem(LS_ACTIVE_PLAYLIST, name); }

function ensurePlaylist(name) {
  const playlists = loadPlaylists();
  const exists = playlists.some(p => p.name.toLowerCase() === name.toLowerCase());
  if (!exists) {
    playlists.unshift({ name, items: [] });
    savePlaylists(playlists);
  }
}
function addToPlaylist(playlistName, item) {
  const playlists = loadPlaylists();
  const pl = playlists.find(p => p.name.toLowerCase() === playlistName.toLowerCase());
  if (!pl) return;

  const n = normalizeItem(item);
  if (!pl.items.some(i => String(i.id) === String(n.id))) {
    pl.items.unshift(n);
    savePlaylists(playlists);
  }
}
function removeFromPlaylist(playlistName, id) {
  const playlists = loadPlaylists();
  const pl = playlists.find(p => p.name.toLowerCase() === playlistName.toLowerCase());
  if (!pl) return;
  pl.items = pl.items.filter(i => String(i.id) !== String(id));
  savePlaylists(playlists);
}
function deleteActivePlaylist() {
  const playlists = loadPlaylists();
  const active = getActivePlaylistName();
  if (!active) return;

  const next = playlists.filter(p => p.name.toLowerCase() !== active.toLowerCase());
  savePlaylists(next);
  setActivePlaylistName(next[0]?.name || "");
  renderPlaylists();
  toast("Playlist deleted.");
}

function renderPlaylists() {
  if (!playlistList) return;
  const playlists = loadPlaylists();
  const active = getActivePlaylistName();

  playlistList.innerHTML = playlists.length
    ? playlists.map(p => {
        const isActive = active && p.name.toLowerCase() === active.toLowerCase();
        return `<button class="pill ${isActive ? "on" : ""}" data-pl="${escapeHtml(p.name)}" type="button">${escapeHtml(p.name)}</button>`;
      }).join("")
    : `<div class="tiny muted">No playlists yet. Create one above.</div>`;

  renderPlaylistItems();
}
function renderPlaylistItems() {
  if (!playlistItems || !activePlaylistTitle) return;

  const playlists = loadPlaylists();
  const active = getActivePlaylistName();
  const pl = playlists.find(p => p.name.toLowerCase() === active.toLowerCase());

  if (!active || !pl) {
    activePlaylistTitle.textContent = "Select a playlist";
    playlistItems.innerHTML = `<div class="tiny muted">Click a playlist chip to view it.</div>`;
    return;
  }

  activePlaylistTitle.textContent = pl.name;

  if (!pl.items.length) {
    playlistItems.innerHTML = `<div class="tiny muted">Empty playlist. Add from recommendations.</div>`;
    return;
  }

  playlistItems.innerHTML = pl.items.map(i => {
    const title = escapeHtml(i.title || "Untitled");
    const year = i.release_date ? i.release_date.slice(0, 4) : "—";
    const poster = i.poster_path ? `<img class="mini-poster" src="${i.poster_path}" alt="">` : "";
    return `
      <div class="mini-item">
        ${poster}
        <div style="flex:1">
          <div class="mini-title">${title}</div>
          <div class="mini-meta">${year} • ${i.media_type}</div>
        </div>
        <button class="btn-small js-pl-remove" data-id="${i.id}" type="button">✕</button>
      </div>
    `;
  }).join("");
}

// ===== Watch later / watched =====
function loadWatchLater() { return loadJson(LS_WATCHLATER, []); }
function saveWatchLater(list) { saveJson(LS_WATCHLATER, list); }
function loadWatched() { return loadJson(LS_WATCHED, []); }
function saveWatched(list) { saveJson(LS_WATCHED, list); }

function addWatchLater(item, vibePrompt) {
  const list = loadWatchLater();
  const entry = { ...normalizeItem(item), vibePrompt: vibePrompt || "", addedAt: Date.now() };
  if (!list.some(x => String(x.id) === String(entry.id))) {
    list.unshift(entry);
    saveWatchLater(list.slice(0, 120));
  }
}
function markWatched(id, rating) {
  const later = loadWatchLater();
  const found = later.find(x => String(x.id) === String(id));
  if (!found) return;

  const watched = loadWatched();
  const entry = { ...found, rating, watchedAt: Date.now() };

  saveWatched([entry, ...watched.filter(w => String(w.id) !== String(id))]);
  saveWatchLater(later.filter(x => String(x.id) !== String(id)));
}

function renderWatchLater() {
  if (!watchLaterList) return;
  const list = loadWatchLater();
  if (!list.length) {
    watchLaterList.innerHTML = `<div class="tiny muted">Nothing saved. Use “Watch later” on a pick.</div>`;
    return;
  }

  watchLaterList.innerHTML = list.map(i => {
    const title = escapeHtml(i.title || "Untitled");
    const year = i.release_date ? i.release_date.slice(0, 4) : "—";
    const poster = i.poster_path ? `<img class="mini-poster" src="${i.poster_path}" alt="">` : "";
    const vibe = i.vibePrompt ? `<div class="tiny muted">Vibe: ${escapeHtml(i.vibePrompt)}</div>` : "";
    return `
      <div class="mini-item">
        ${poster}
        <div style="flex:1">
          <div class="mini-title">${title}</div>
          <div class="mini-meta">${year} • ${i.media_type}</div>
          ${vibe}
          <div class="actions-row">
            <button class="btn-small js-watched" data-id="${i.id}" type="button">✅ Mark watched</button>
            <button class="btn-small js-later-remove" data-id="${i.id}" type="button">✕ Remove</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function renderWatched() {
  if (!watchedList) return;
  const list = loadWatched();
  if (!list.length) {
    watchedList.innerHTML = `<div class="tiny muted">Watched list is empty.</div>`;
    return;
  }

  watchedList.innerHTML = list.map(i => {
    const title = escapeHtml(i.title || "Untitled");
    const year = i.release_date ? i.release_date.slice(0, 4) : "—";
    const poster = i.poster_path ? `<img class="mini-poster" src="${i.poster_path}" alt="">` : "";
    const vibe = i.vibePrompt ? `<div class="tiny muted">Original vibe: ${escapeHtml(i.vibePrompt)}</div>` : "";
    const rating = Number.isFinite(i.rating) ? `<div class="mini-meta">⭐ Your rating: ${i.rating}/10</div>` : "";
    return `
      <div class="mini-item">
        ${poster}
        <div style="flex:1">
          <div class="mini-title">${title}</div>
          <div class="mini-meta">${year} • ${i.media_type}</div>
          ${rating}
          ${vibe}
        </div>
      </div>
    `;
  }).join("");
}

// ===== Provider pills =====
function renderProviderPills() {
  document.querySelectorAll(".js-provider").forEach(btn => {
    const p = btn.dataset.provider;
    const inc = providerPrefs.include.some(x => x.toLowerCase() === p.toLowerCase());
    const exc = providerPrefs.exclude.some(x => x.toLowerCase() === p.toLowerCase());
    btn.classList.remove("on", "off");
    if (inc) btn.classList.add("on");
    if (exc) btn.classList.add("off");
  });
  saveJson(LS_PROVIDER_PREFS, providerPrefs);
}
const providerRow = document.getElementById("provider-row");
if (providerRow) {
  providerRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".js-provider");
    if (!btn) return;

    const p = btn.dataset.provider;

    if (e.shiftKey) {
      const has = providerPrefs.exclude.some(x => x.toLowerCase() === p.toLowerCase());
      providerPrefs.exclude = has
        ? providerPrefs.exclude.filter(x => x.toLowerCase() !== p.toLowerCase())
        : [...providerPrefs.exclude, p];
      providerPrefs.include = providerPrefs.include.filter(x => x.toLowerCase() !== p.toLowerCase());
    } else {
      const has = providerPrefs.include.some(x => x.toLowerCase() === p.toLowerCase());
      providerPrefs.include = has
        ? providerPrefs.include.filter(x => x.toLowerCase() !== p.toLowerCase())
        : [...providerPrefs.include, p];
      providerPrefs.exclude = providerPrefs.exclude.filter(x => x.toLowerCase() !== p.toLowerCase());
    }

    renderProviderPills();
  });
}

// ===== API =====
async function fetchRecommendations(prompt, opts = {}) {
  const liked = loadJson(LS_LIKED, []);
  const disliked = loadJson(LS_DISLIKED, []);
  const watched = loadWatched(); // ✅ send watched history to backend
  const region = getRegion();

  const excludeIds = opts.excludeIds || [];
  const refreshToken = opts.refreshToken || "";
  const mood = Number(moodEl?.value || 3);
  const localHour = getLocalHour();

  const res = await fetch(`${API_BASE}/api/recommend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      mood,
      localHour,
      liked,
      disliked,
      watched,
      excludeIds,
      region,
      refreshToken,
      providerInclude: providerPrefs.include,
      providerExclude: providerPrefs.exclude
    })
  });

  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();

  return Array.isArray(data.results) ? data.results : [];
}

// ===== Results render =====
function renderResults(items) {
  if (!resultBody) return;

  items = Array.from(new Map((items || []).map(x => [`${x.media_type}:${x.id}`, x])).values());

  if (!items.length) {
    resultBody.innerHTML =
      "<p class='muted'>No results returned. Try removing provider filters or changing the vibe.</p>";
    return;
  }

  if (resultsSub) resultsSub.textContent = `Top pick + ${Math.max(0, items.length - 1)} alternatives`;

  resultBody.innerHTML = items.map((item, idx) => {
    const title = escapeHtml(item.title || "Untitled");
    const year = item.release_date ? item.release_date.slice(0, 4) : "—";
    const type = item.media_type === "tv" ? "Series" : "Movie";
    const rating = item.vote_average ? `${Number(item.vote_average).toFixed(1)}/10` : "No rating";
    const overview = escapeHtml(item.overview || "No description available.");
    const poster = item.poster_path ? `<img class="result-poster" src="${item.poster_path}" alt="${title} poster" />` : "";
    const providers = (Array.isArray(item.providers) && item.providers.length)
      ? `Watch on: ${escapeHtml(item.providers.join(", "))}`
      : `Watch on: (not listed for GB)`;
    const reason = item.reason ? `<div class="result-reason">Why this: ${escapeHtml(item.reason)}</div>` : "";
    const topBadge = idx === 0 ? `<span class="badge">Top pick</span>` : `<span class="badge">Alt</span>`;

    return `
      <article class="result-item" data-idx="${idx}">
        ${poster}
        <div style="flex:1">
          <div class="result-title">${title} (${year}) ${topBadge}</div>
          <div class="result-meta">⭐ ${rating} • ${type}</div>
          <div class="result-meta">${providers}</div>
          ${reason}
          <div class="result-overview">${overview}</div>
          <div class="actions-row">
            <button class="btn-small js-like" data-idx="${idx}" type="button">👍 Like</button>
            <button class="btn-small js-dislike" data-idx="${idx}" type="button">👎 Dislike</button>
            <button class="btn-small js-add" data-idx="${idx}" type="button">➕ Playlist</button>
            <button class="btn-small js-later" data-idx="${idx}" type="button">🕒 Watch later</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

// ===== Events =====
if (aiForm) {
  aiForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = (promptEl?.value || "").trim();
    if (!prompt) return;

    lastPrompt = prompt;
    lastRefreshToken = String(Date.now());

    if (resultsCard) resultsCard.hidden = false;
    if (resultBody) resultBody.innerHTML = "<p class='muted'>Thinking…</p>";

    try {
      const items = await fetchRecommendations(prompt, { refreshToken: lastRefreshToken });
      lastItems = items;
      renderResults(items);
    } catch (err) {
      console.error(err);
      if (resultBody) resultBody.innerHTML = "<p class='muted'>Server error. Check Render logs.</p>";
    }
  });
}

if (btnRefresh) {
  btnRefresh.addEventListener("click", async () => {
    if (!lastPrompt) return toast("Search first.");
    if (resultBody) resultBody.innerHTML = "<p class='muted'>Refreshing…</p>";
    try {
      lastRefreshToken = String(Date.now());
      const items = await fetchRecommendations(lastPrompt, {
        refreshToken: lastRefreshToken,
        excludeIds: currentExcludeIds()
      });
      lastItems = items;
      renderResults(items);
      toast("Fresh picks.");
    } catch (e) {
      console.error(e);
      if (resultBody) resultBody.innerHTML = "<p class='muted'>Refresh failed.</p>";
    }
  });
}

if (btnSurprise) {
  btnSurprise.addEventListener("click", () => {
    const examples = [
      "Surprise me with something cozy and fun.",
      "Surprise me with a feel-good classic.",
      "Surprise me with a clever comedy.",
      "Surprise me with an intense thriller (not too scary).",
      "Surprise me with a chill series for late night."
    ];
    const base = examples[Math.floor(Math.random() * examples.length)];
    if (promptEl) promptEl.value = base;
    aiForm?.dispatchEvent(new Event("submit", { cancelable: true }));
  });
}

// Results buttons
if (resultBody) {
  resultBody.addEventListener("click", (e) => {
    const likeBtn = e.target.closest(".js-like");
    const dislikeBtn = e.target.closest(".js-dislike");
    const addBtn = e.target.closest(".js-add");
    const laterBtn = e.target.closest(".js-later");
    if (!likeBtn && !dislikeBtn && !addBtn && !laterBtn) return;

    const idx = Number((likeBtn || dislikeBtn || addBtn || laterBtn).dataset.idx);
    const item = lastItems[idx];
    if (!item) return;

    if (likeBtn) {
      addToLiked(item);
      toast(`Liked: ${item.title}`);
      likeBtn.textContent = "✅ Liked";
      likeBtn.disabled = true;
      return;
    }

    if (dislikeBtn) {
      addToDisliked(item);
      toast(`Disliked: ${item.title}`);
      lastItems = lastItems.filter((_, i) => i !== idx);
      renderResults(lastItems);
      return;
    }

    if (addBtn) {
      const playlists = loadPlaylists();
      const active = getActivePlaylistName();
      if (!playlists.length) return toast("Create a playlist first.");
      const target = active || playlists[0].name;
      addToPlaylist(target, item);
      toast(`Added to "${target}"`);
      renderPlaylists();
      return;
    }

    if (laterBtn) {
      addWatchLater(item, lastPrompt);
      toast("Saved to Watch later.");
      renderWatchLater();
    }
  });
}

// Playlist events
if (playlistForm) {
  playlistForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = (playlistNameInput?.value || "").trim();
    if (!name) return toast("Enter a playlist name.");
    ensurePlaylist(name);
    setActivePlaylistName(name);
    playlistNameInput.value = "";
    renderPlaylists();
    toast(`Created: ${name}`);
  });
}

if (playlistList) {
  playlistList.addEventListener("click", (e) => {
    const chip = e.target.closest(".pill");
    if (!chip) return;
    const name = chip.dataset.pl;
    setActivePlaylistName(name);
    renderPlaylists();
  });
}

if (playlistItems) {
  playlistItems.addEventListener("click", (e) => {
    const btn = e.target.closest(".js-pl-remove");
    if (!btn) return;
    const id = btn.dataset.id;
    const active = getActivePlaylistName();
    if (!active) return;
    removeFromPlaylist(active, id);
    renderPlaylists();
    toast("Removed from playlist.");
  });
}

if (btnDeletePlaylist) {
  btnDeletePlaylist.addEventListener("click", () => {
    const active = getActivePlaylistName();
    if (!active) return toast("Select a playlist first.");
    if (confirm(`Delete playlist "${active}"?`)) deleteActivePlaylist();
  });
}

// Watch later / watched
if (watchLaterList) {
  watchLaterList.addEventListener("click", (e) => {
    const w = e.target.closest(".js-watched");
    const r = e.target.closest(".js-later-remove");

    if (r) {
      const id = r.dataset.id;
      const list = loadWatchLater().filter(x => String(x.id) !== String(id));
      saveWatchLater(list);
      renderWatchLater();
      toast("Removed.");
      return;
    }

    if (w) {
      const id = w.dataset.id;
      const rating = prompt("Rate it out of 10 (1–10):");
      const n = Number(rating);
      if (!Number.isFinite(n) || n < 1 || n > 10) return toast("Rating must be 1–10.");
      markWatched(id, n);
      renderWatchLater();
      renderWatched();
      toast("Saved to Watched.");
    }
  });
}

// Clear buttons
if (btnClear) {
  btnClear.addEventListener("click", () => {
    localStorage.removeItem(LS_LIKED);
    localStorage.removeItem(LS_DISLIKED);
    toast("Cleared likes and dislikes.");
  });
}
if (btnClearLater) {
  btnClearLater.addEventListener("click", () => {
    localStorage.removeItem(LS_WATCHLATER);
    renderWatchLater();
    toast("Cleared Watch later.");
  });
}
if (btnClearWatched) {
  btnClearWatched.addEventListener("click", () => {
    localStorage.removeItem(LS_WATCHED);
    renderWatched();
    toast("Cleared Watched.");
  });
}

// Onboarding
function maybeShowOnboarding() {
  const done = localStorage.getItem(LS_ONBOARDED);
  if (!done && onboardModal) onboardModal.hidden = false;
}
if (onboardClose) {
  onboardClose.addEventListener("click", () => {
    localStorage.setItem(LS_ONBOARDED, "1");
    if (onboardModal) onboardModal.hidden = true;
  });
}
if (onboardModal) {
  onboardModal.addEventListener("click", (e) => {
    if (e.target === onboardModal) {
      localStorage.setItem(LS_ONBOARDED, "1");
      onboardModal.hidden = true;
    }
  });
}
document.querySelectorAll(".js-example").forEach(btn => {
  btn.addEventListener("click", () => {
    if (promptEl) promptEl.value = btn.dataset.text || "";
    localStorage.setItem(LS_ONBOARDED, "1");
    if (onboardModal) onboardModal.hidden = true;
    aiForm?.dispatchEvent(new Event("submit", { cancelable: true }));
  });
});

// Init
renderPlaylists();
renderWatchLater();
renderWatched();
renderProviderPills();
maybeShowOnboarding();
