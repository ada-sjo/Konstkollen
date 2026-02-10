/* global pdfjsLib */

const STATUS = [
  { label: "", className: "status-0" },
  { label: "Favorit", className: "status-1" },
  { label: "Kanske", className: "status-2" },
  { label: "Nej tack", className: "status-3" }
];

const fileInput = document.getElementById("pdfInput");
const grid = document.getElementById("grid");
const toast = document.getElementById("toast");
const searchInput = document.getElementById("searchInput");
const filterTabs = Array.from(document.querySelectorAll(".tab"));
const tabCountNodes = Array.from(document.querySelectorAll(".tab-count"));
const rankToggle = document.getElementById("rankToggle");
const rankingPanel = document.getElementById("rankingPanel");
const rankingList = document.getElementById("rankingList");
const sortSelect = document.getElementById("sortSelect");
const resetAppButton = document.getElementById("resetApp");
const resetMarksButton = document.getElementById("resetMarks");
const resetRankButton = document.getElementById("resetRank");
const emptyState = document.getElementById("emptyState");
const viewToggles = Array.from(document.querySelectorAll(".view-toggle"));

const countFavorite = document.getElementById("count-favorite");
const countMaybe = document.getElementById("count-maybe");
const countNope = document.getElementById("count-nope");

let artworks = [];
let cardRefs = [];
let currentFilter = "all";
let searchQuery = "";
let sortMode = "number";
let isRanking = false;
let draggedItem = null;
let viewMode = "grid";
const tabCounts = tabCountNodes.reduce((acc, node) => {
  acc[node.dataset.count] = node;
  return acc;
}, {});
const STORAGE_KEY = "konstkollen_state_v1";
let storageDisabled = false;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  await loadPdf(file);
});

if (searchInput) {
  searchInput.addEventListener("input", (event) => {
    searchQuery = event.target.value.trim().toLowerCase();
    applyFilters();
  });
}

filterTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    currentFilter = tab.dataset.filter || "all";
    filterTabs.forEach((btn) => btn.classList.remove("active"));
    tab.classList.add("active");
    applyFilters();
  });
});

if (resetAppButton) {
  resetAppButton.addEventListener("click", () => {
    if (confirm("Är du säker på att du vill nollställa hela appen?")) {
      resetAppState();
    }
  });
}

if (resetMarksButton) {
  resetMarksButton.addEventListener("click", () => {
    if (confirm("Är du säker på att du vill nollställa alla markeringar?")) {
      resetAllStatuses();
    }
  });
}

if (resetRankButton) {
  resetRankButton.addEventListener("click", () => {
    if (confirm("Är du säker på att du vill nollställa rangordningen?")) {
      resetRankings();
    }
  });
}

if (sortSelect) {
  sortSelect.addEventListener("change", (event) => {
    sortMode = event.target.value;
    renderGrid();
    persistState();
  });
}

viewToggles.forEach((toggle) => {
  toggle.addEventListener("click", () => {
    if (isRanking) return;
    const mode = toggle.dataset.view;
    if (!mode) return;
    setViewMode(mode);
    renderGrid();
    persistState();
  });
});

if (rankToggle) {
  rankToggle.addEventListener("click", () => {
    if (!artworks.length) {
      showToast("Ladda upp en PDF först.");
      return;
    }
    if (isRanking) {
      exitRankingMode();
    } else {
      enterRankingMode();
    }
  });
}

const IMAGE_MIN_SIZE = 40;
const IMAGE_PADDING = 6;
const RENDER_SCALE = 1.4;

async function loadPdf(file) {
  if (!window.pdfjsLib) {
    showToast("Kunde inte ladda PDF-motorn.");
    return;
  }

  showToast("Läser PDF...");
  grid.innerHTML = "";
  artworks = [];
  cardRefs = [];
  searchQuery = "";
  if (searchInput) searchInput.value = "";
  updateCounts();
  updateTabCounts();

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: context, viewport }).promise;

      const [pairs, imageBoxes] = await Promise.all([
        extractPairs(page),
        extractImageBoxes(page, viewport)
      ]);

      const sortedImages = imageBoxes.sort(sortByPosition);
      const sortedPairs = normalizePairs(pairs);

      if (sortedImages.length !== sortedPairs.length) {
        console.warn(
          `Sida ${pageNumber}: hittade ${sortedImages.length} bilder och ${sortedPairs.length} texter.`
        );
      }

      const count = Math.min(sortedImages.length, sortedPairs.length);
      for (let i = 0; i < count; i += 1) {
        const crop = cropFromCanvas(canvas, sortedImages[i]);
        const pair = sortedPairs[i];
        artworks.push({
          id: `${pageNumber}-${i}`,
          image: crop,
          number: pair.number,
          artist: pair.artist,
          status: 0,
          removed: false,
          rank: 0
        });
      }
    }

    assignInitialRanks();
    sortMode = "number";
    if (sortSelect) sortSelect.value = sortMode;
    renderGrid();
    persistState();
    showToast(`Klar! Läste ${artworks.length} verk.`);
  } catch (error) {
    console.error(error);
    showToast("Något gick fel vid läsning av PDF.");
  }
}

function restoreState() {
  if (storageDisabled) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.artworks)) return;
    artworks = parsed.artworks.map((item) => ({
      id: item.id,
      image: item.image,
      number: item.number,
      artist: item.artist,
      status: item.status ?? 0,
      removed: item.removed ?? false,
      rank: item.rank ?? 0
    }));
    sortMode = parsed.sortMode === "rank" ? "rank" : "number";
    viewMode = parsed.viewMode || "grid";
    if (sortSelect) sortSelect.value = sortMode;
    if (!artworks.some((art) => art.rank)) {
      assignInitialRanks();
    }
    setViewMode(viewMode);
    renderGrid();
    showToast("Tidigare val återställda.");
  } catch (error) {
    console.warn("Kunde inte läsa sparad data", error);
  }
}

function persistState() {
  if (storageDisabled) return;
  try {
    const payload = JSON.stringify({ artworks, sortMode, viewMode });
    localStorage.setItem(STORAGE_KEY, payload);
  } catch (error) {
    storageDisabled = true;
    console.warn("Kunde inte spara till localStorage", error);
    showToast("Kunde inte spara lokalt (utrymme fullt).");
  }
}

async function extractPairs(page) {
  const textContent = await page.getTextContent();
  const lines = groupLines(textContent.items);
  const pairs = [];
  const pattern = /(\d{1,3})\.\s*([^\d]+?)(?=\s*\d{1,3}\.\s*|$)/g;

  for (const line of lines) {
    if (/Sweco konstförening/i.test(line)) continue;
    if (/verkslista/i.test(line)) continue;

    let match;
    while ((match = pattern.exec(line)) !== null) {
      const number = match[1];
      const artist = match[2].replace(/\s+/g, " ").trim();
      if (artist) {
        pairs.push({ number, artist });
      }
    }
  }

  return pairs;
}

function normalizePairs(pairs) {
  const allNumeric = pairs.every((pair) => /^\d+$/.test(pair.number));
  if (!allNumeric) return pairs;
  return [...pairs].sort((a, b) => Number(a.number) - Number(b.number));
}

function groupLines(items) {
  const cleaned = items
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({
      text: item.str.trim(),
      x: item.transform[4],
      y: item.transform[5]
    }));

  cleaned.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  const tolerance = 3;

  for (const item of cleaned) {
    let line = lines.find((entry) => Math.abs(entry.y - item.y) <= tolerance);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) =>
      line.items
        .sort((a, b) => a.x - b.x)
        .map((entry) => entry.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

async function extractImageBoxes(page, viewport) {
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const { OPS, Util } = pdfjsLib;

  let transform = viewport.transform;
  const stack = [];
  const boxes = [];

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i];

    switch (fn) {
      case OPS.save:
        stack.push(transform);
        break;
      case OPS.restore:
        transform = stack.pop() || viewport.transform;
        break;
      case OPS.transform:
        transform = Util.transform(transform, args);
        break;
      case OPS.paintImageXObject:
      case OPS.paintJpegXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageXObjectRepeat: {
        const box = transformToBox(Util, transform);
        if (!box) break;
        if (box.width < IMAGE_MIN_SIZE || box.height < IMAGE_MIN_SIZE) break;
        if (
          box.width > viewport.width * 0.95 &&
          box.height > viewport.height * 0.95
        ) {
          break;
        }
        boxes.push(box);
        break;
      }
      default:
        break;
    }
  }

  return dedupeBoxes(boxes);
}

function transformToBox(Util, transform) {
  if (!transform) return null;
  const p1 = Util.applyTransform([0, 0], transform);
  const p2 = Util.applyTransform([1, 0], transform);
  const p3 = Util.applyTransform([0, 1], transform);
  const p4 = Util.applyTransform([1, 1], transform);
  const xs = [p1[0], p2[0], p3[0], p4[0]];
  const ys = [p1[1], p2[1], p3[1], p4[1]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function dedupeBoxes(boxes) {
  const seen = new Set();
  const result = [];
  for (const box of boxes) {
    const key = [
      Math.round(box.x),
      Math.round(box.y),
      Math.round(box.width),
      Math.round(box.height)
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(box);
  }
  return result;
}

function sortByPosition(a, b) {
  const rowA = Math.round(a.y / 10);
  const rowB = Math.round(b.y / 10);
  if (rowA !== rowB) {
    return rowA - rowB;
  }
  return a.x - b.x;
}

function cropFromCanvas(source, box) {
  const padding = IMAGE_PADDING;
  const sx = Math.max(0, Math.floor(box.x - padding));
  const sy = Math.max(0, Math.floor(box.y - padding));
  const sw = Math.min(
    source.width - sx,
    Math.ceil(box.width + padding * 2)
  );
  const sh = Math.min(
    source.height - sy,
    Math.ceil(box.height + padding * 2)
  );

  if (sw <= 0 || sh <= 0) return "";

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/jpeg", 0.86);
}

function compareNumbers(a, b) {
  const numA = Number.parseInt(String(a).replace(/\D+/g, ""), 10);
  const numB = Number.parseInt(String(b).replace(/\D+/g, ""), 10);
  if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) {
    return numA - numB;
  }
  return String(a).localeCompare(String(b), "sv", { numeric: true });
}

function getSortedIndices() {
  const indices = artworks.map((_, index) => index);
  if (sortMode === "rank") {
    return indices.sort((a, b) => {
      const rankA = Number.isFinite(artworks[a].rank) ? artworks[a].rank : 1e9;
      const rankB = Number.isFinite(artworks[b].rank) ? artworks[b].rank : 1e9;
      if (rankA !== rankB) return rankA - rankB;
      return compareNumbers(artworks[a].number, artworks[b].number);
    });
  }
  return indices.sort((a, b) =>
    compareNumbers(artworks[a].number, artworks[b].number)
  );
}

function getRankedIndices() {
  const indices = artworks.map((_, index) => index);
  return indices.sort((a, b) => {
    const rankA = Number.isFinite(artworks[a].rank) ? artworks[a].rank : 1e9;
    const rankB = Number.isFinite(artworks[b].rank) ? artworks[b].rank : 1e9;
    if (rankA !== rankB) return rankA - rankB;
    return compareNumbers(artworks[a].number, artworks[b].number);
  });
}

function assignInitialRanks() {
  const indices = artworks.map((_, index) => index);
  indices.sort((a, b) => compareNumbers(artworks[a].number, artworks[b].number));
  indices.forEach((index, position) => {
    artworks[index].rank = position;
  });
}

function getRankPositions() {
  const positions = {};
  getRankedIndices().forEach((index, position) => {
    positions[index] = position + 1;
  });
  return positions;
}

function renderGrid() {
  grid.innerHTML = "";
  cardRefs = [];

  const sortedIndices = getSortedIndices();
  const rankPositions = getRankPositions();

  sortedIndices.forEach((index) => {
    const artwork = artworks[index];
    const card = document.createElement("article");
    card.className = "card";
    setCardStatus(card, artwork.status);
    setCardRemoved(card, artwork.removed);
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.dataset.index = index;
    card.dataset.status = artwork.status;

    const thumb = document.createElement("div");
    thumb.className = "thumb";

    const img = document.createElement("img");
    img.alt = `Konstverk ${artwork.number}`;
    img.src = artwork.image;

    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const rankBadge = document.createElement("div");
    rankBadge.className = "rank-badge";
    rankBadge.textContent = `#${rankPositions[index] ?? "-"}`;

    const drawButton = document.createElement("button");
    drawButton.type = "button";
    drawButton.className = "draw-button";
    drawButton.textContent = artwork.removed ? "↺" : "×";
    drawButton.setAttribute(
      "aria-label",
      artwork.removed ? "Återställ draget verk" : "Markera som draget verk"
    );
    drawButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleRemoved(index);
    });

    thumb.append(img, overlay, rankBadge);

    const meta = document.createElement("div");
    meta.className = "meta";

    const artist = document.createElement("div");
    artist.className = "artist";
    artist.textContent = artwork.artist;

    const number = document.createElement("div");
    number.className = "number";
    number.textContent = `Verk ${artwork.number}`;

    meta.append(artist, number);

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = artwork.removed ? "Draget" : STATUS[artwork.status].label;

    card.append(thumb, meta, badge, drawButton);

    card.addEventListener("click", () => {
      cycleStatus(card);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        cycleStatus(card);
      }
    });

    grid.append(card);
    cardRefs[index] = card;
  });

  updateCounts();
  updateTabCounts();
  applyFilters();
}

function cycleStatus(card) {
  const index = Number(card.dataset.index);
  if (artworks[index].removed) return;
  let status = Number(card.dataset.status);

  status = (status + 1) % STATUS.length;

  artworks[index].status = status;
  card.dataset.status = status;
  setCardStatus(card, status);

  const badge = card.querySelector(".badge");
  badge.textContent = STATUS[status].label;

  updateCounts();
  updateTabCounts();
  applyFilters();
  persistState();
}

function updateCounts() {
  const counts = { 1: 0, 2: 0, 3: 0 };

  artworks.forEach((art) => {
    if (art.removed) return;
    if (counts[art.status] !== undefined) {
      counts[art.status] += 1;
    }
  });

  countFavorite.textContent = counts[1] || 0;
  countMaybe.textContent = counts[2] || 0;
  countNope.textContent = counts[3] || 0;
}

function updateTabCounts() {
  const counts = {
    all: 0,
    favorite: 0,
    maybe: 0,
    nope: 0,
    unmarked: 0,
    removed: 0
  };

  artworks.forEach((artwork) => {
    const artistText = (artwork.artist || "").toLowerCase();
    const numberText = String(artwork.number || "").toLowerCase();
    const matchesSearch =
      !searchQuery ||
      artistText.includes(searchQuery) ||
      numberText.includes(searchQuery);

    if (!matchesSearch) return;

    if (artwork.removed) {
      counts.removed += 1;
      return;
    }

    counts.all += 1;
    if (artwork.status === 1) counts.favorite += 1;
    else if (artwork.status === 2) counts.maybe += 1;
    else if (artwork.status === 3) counts.nope += 1;
    else counts.unmarked += 1;
  });

  Object.entries(tabCounts).forEach(([key, node]) => {
    node.textContent = counts[key] ?? 0;
  });
}

function resetAllStatuses() {
  artworks.forEach((artwork, index) => {
    artwork.status = 0;
    const card = cardRefs[index];
    if (!card) return;
    card.dataset.status = 0;
    setCardStatus(card, 0);
    const badge = card.querySelector(".badge");
    if (badge) badge.textContent = artwork.removed ? "Draget" : "";
  });
  updateCounts();
  updateTabCounts();
  applyFilters();
  persistState();
}

function resetRankings() {
  assignInitialRanks();
  updateTabCounts();
  if (sortMode === "rank") {
    renderGrid();
  }
  updateRankBadges();
  if (isRanking) {
    renderRankingList();
  }
  persistState();
  showToast("Rangordningen är nollställd.");
}

function setViewMode(mode) {
  viewMode = mode;
  document.body.classList.remove("view-grid", "view-grid-compact", "view-list");
  document.body.classList.add(`view-${mode}`);
  viewToggles.forEach((toggle) => {
    toggle.classList.toggle("active", toggle.dataset.view === mode);
  });
}

function applyFilters() {
  updateTabCounts();
  if (!cardRefs.length) {
    if (emptyState) emptyState.hidden = true;
    return;
  }

  let visibleCount = 0;

  artworks.forEach((artwork, index) => {
    const card = cardRefs[index];
    if (!card) return;

    const matchesFilter = filterMatches(artwork, currentFilter);
    const artistText = (artwork.artist || "").toLowerCase();
    const numberText = String(artwork.number || "").toLowerCase();
    const matchesSearch =
      !searchQuery ||
      artistText.includes(searchQuery) ||
      numberText.includes(searchQuery);

    const isVisible = matchesFilter && matchesSearch;
    card.style.display = isVisible ? "" : "none";
    if (isVisible) visibleCount += 1;
  });

  if (emptyState) emptyState.hidden = visibleCount !== 0;
}

function setCardStatus(card, status) {
  STATUS.forEach((entry) => {
    if (entry.className) {
      card.classList.remove(entry.className);
    }
  });
  if (STATUS[status] && STATUS[status].className) {
    card.classList.add(STATUS[status].className);
  }
}

function setCardRemoved(card, removed) {
  if (removed) {
    card.classList.add("removed");
  } else {
    card.classList.remove("removed");
  }
}

function toggleRemoved(index) {
  const artwork = artworks[index];
  if (!artwork) return;
  artwork.removed = !artwork.removed;

  const card = cardRefs[index];
  if (card) {
    setCardRemoved(card, artwork.removed);
    const badge = card.querySelector(".badge");
    if (badge) {
      badge.textContent = artwork.removed
        ? "Draget"
        : STATUS[artwork.status].label;
    }
    const drawButton = card.querySelector(".draw-button");
    if (drawButton) {
      drawButton.textContent = artwork.removed ? "↺" : "×";
      drawButton.setAttribute(
        "aria-label",
        artwork.removed ? "Återställ draget verk" : "Markera som draget verk"
      );
    }
  }

  updateCounts();
  applyFilters();
  persistState();
  if (isRanking) {
    renderRankingList();
  }
}

function resetAppState() {
  artworks = [];
  cardRefs = [];
  currentFilter = "all";
  searchQuery = "";
  sortMode = "number";
  isRanking = false;
  viewMode = "grid";
  if (sortSelect) sortSelect.value = sortMode;
  document.body.classList.remove("is-ranking");
  if (rankingPanel) rankingPanel.hidden = true;
  if (rankingList) rankingList.innerHTML = "";
  if (rankToggle) {
    rankToggle.classList.remove("active");
    rankToggle.textContent = "Rangordna";
  }
  setViewMode(viewMode);
  if (searchInput) searchInput.value = "";
  if (searchInput) searchInput.disabled = false;
  if (sortSelect) sortSelect.disabled = false;
  filterTabs.forEach((btn) => btn.classList.remove("active"));
  const allTab = filterTabs.find((btn) => btn.dataset.filter === "all");
  if (allTab) allTab.classList.add("active");
  grid.innerHTML = "";
  updateCounts();
  updateTabCounts();
  if (emptyState) emptyState.hidden = true;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("Kunde inte rensa localStorage", error);
  }
  showToast("Appen är nollställd.");
}

function filterMatches(artwork, filter) {
  if (filter === "removed") {
    return artwork.removed;
  }
  if (artwork.removed) return false;
  switch (filter) {
    case "favorite":
      return artwork.status === 1;
    case "maybe":
      return artwork.status === 2;
    case "nope":
      return artwork.status === 3;
    case "unmarked":
      return artwork.status === 0;
    default:
      return true;
  }
}

function enterRankingMode() {
  isRanking = true;
  document.body.classList.add("is-ranking");
  if (rankToggle) {
    rankToggle.classList.add("active");
    rankToggle.textContent = "Klart";
  }
  if (rankingPanel) rankingPanel.hidden = false;
  if (emptyState) emptyState.hidden = true;
  if (searchInput) searchInput.disabled = true;
  if (sortSelect) sortSelect.disabled = true;
  renderRankingList();
}

function exitRankingMode() {
  isRanking = false;
  document.body.classList.remove("is-ranking");
  if (rankToggle) {
    rankToggle.classList.remove("active");
    rankToggle.textContent = "Rangordna";
  }
  if (rankingPanel) rankingPanel.hidden = true;
  if (searchInput) searchInput.disabled = false;
  if (sortSelect) sortSelect.disabled = false;
  renderGrid();
  persistState();
}

function renderRankingList() {
  if (!rankingList) return;
  rankingList.innerHTML = "";

  const indices = getRankedIndices().filter((index) => !artworks[index].removed);

  indices.forEach((index, position) => {
    const artwork = artworks[index];
    const item = document.createElement("li");
    item.className = "ranking-item";
    item.draggable = true;
    item.dataset.index = index;
    item.dataset.status = artwork.status;
    if (artwork.status === 1) item.classList.add("status-1");
    if (artwork.status === 2) item.classList.add("status-2");
    if (artwork.status === 3) item.classList.add("status-3");

    const rank = document.createElement("div");
    rank.className = "ranking-rank";
    rank.textContent = String(position + 1);

    const thumb = document.createElement("img");
    thumb.className = "ranking-thumb";
    thumb.src = artwork.image;
    thumb.alt = `Konstverk ${artwork.number}`;

    const meta = document.createElement("div");
    meta.className = "ranking-meta";

    const artist = document.createElement("div");
    artist.className = "ranking-artist";
    artist.textContent = artwork.artist;

    const number = document.createElement("div");
    number.className = "ranking-number";
    number.textContent = `Verk ${artwork.number}`;

    meta.append(artist, number);

    const handle = document.createElement("div");
    handle.className = "ranking-handle";
    handle.textContent = "⋮⋮";

    item.append(rank, thumb, meta, handle);
    rankingList.append(item);
  });

  updateRankingNumbers();
}

function updateRanksFromList() {
  if (!rankingList) return;
  const items = Array.from(rankingList.querySelectorAll(".ranking-item"));
  items.forEach((item, position) => {
    const index = Number(item.dataset.index);
    if (!Number.isNaN(index) && artworks[index]) {
      artworks[index].rank = position;
    }
  });

  const removedIndices = artworks
    .map((artwork, index) => ({ artwork, index }))
    .filter(({ artwork }) => artwork.removed)
    .sort((a, b) => (a.artwork.rank ?? 0) - (b.artwork.rank ?? 0));

  removedIndices.forEach(({ index }, position) => {
    artworks[index].rank = items.length + position;
  });

  if (sortMode === "rank") {
    renderGrid();
  }
  updateRankBadges();
  persistState();
}

function updateRankingNumbers() {
  if (!rankingList) return;
  const items = Array.from(rankingList.querySelectorAll(".ranking-item"));
  items.forEach((item, position) => {
    const label = item.querySelector(".ranking-rank");
    if (label) {
      label.textContent = String(position + 1);
    }
  });
}

function updateRankBadges() {
  const positions = getRankPositions();
  cardRefs.forEach((card, index) => {
    if (!card) return;
    const badge = card.querySelector(".rank-badge");
    if (badge) {
      badge.textContent = `#${positions[index] ?? "-"}`;
    }
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [
    ...container.querySelectorAll(".ranking-item:not(.dragging)")
  ];

  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function handleAutoScroll(clientY) {
  const threshold = 80;
  const speed = 12;
  if (clientY < threshold) {
    window.scrollBy({ top: -speed });
  } else if (clientY > window.innerHeight - threshold) {
    window.scrollBy({ top: speed });
  }
}

function initRankingDnD() {
  if (!rankingList) return;

  rankingList.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".ranking-item");
    if (!item) return;
    draggedItem = item;
    item.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });

  rankingList.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!draggedItem) return;
    handleAutoScroll(event.clientY);
    const afterElement = getDragAfterElement(rankingList, event.clientY);
    if (!afterElement) {
      rankingList.appendChild(draggedItem);
    } else if (afterElement !== draggedItem) {
      rankingList.insertBefore(draggedItem, afterElement);
    }
    updateRankingNumbers();
  });

  rankingList.addEventListener("drop", (event) => {
    event.preventDefault();
  });

  rankingList.addEventListener("dragend", () => {
    if (!draggedItem) return;
    draggedItem.classList.remove("dragging");
    draggedItem = null;
    updateRanksFromList();
    updateRankingNumbers();
  });
}

let toastTimeout;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 2200);
}

initRankingDnD();
restoreState();
setViewMode(viewMode);
