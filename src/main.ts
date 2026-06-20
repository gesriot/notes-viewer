import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import hljs from "highlight.js";
import "highlight.js/styles/vs2015.css"; // dark-ish theme close to VS Code
import "katex/dist/katex.min.css";

// Types matching backend
interface NoteInfo {
  path: string;
  title: string;
  tags: string[];
}

interface AppState {
  notes: NoteInfo[];
  filtered: NoteInfo[];
  selectedIndex: number;
  currentNotePath: string | null;
  searchQuery: string;
}

const state: AppState = {
  notes: [],
  filtered: [],
  selectedIndex: 0,
  currentNotePath: null,
  searchQuery: "",
};

let noteListEl: HTMLDivElement;
let currentImages: string[] = [];
let focusedImageIdx = 0;
let previewEl: HTMLDivElement;
let searchEl: HTMLInputElement;
let titleEl: HTMLSpanElement;
let tagsEl: HTMLSpanElement;
let countEl: HTMLSpanElement;

function setupMarked() {
  marked.setOptions({
    gfm: true,
    breaks: false,
    highlight(code: string, lang?: string) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  });
}

function searchTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean);
}

function noteMatches(note: NoteInfo, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  return tokens.every((token) =>
    note.tags.some((tag) => tag.toLowerCase().includes(token))
  );
}

function applyFilter() {
  const tokens = searchTokens(state.searchQuery);
  state.filtered = state.notes.filter((n) => noteMatches(n, tokens));
  if (state.filtered.length > 0) {
    // try to keep current selection if possible
    const current = state.currentNotePath;
    let idx = state.filtered.findIndex((n) => n.path === current);
    if (idx === -1) idx = 0;
    state.selectedIndex = idx;
  } else {
    state.selectedIndex = 0;
  }
  renderList();
  if (state.filtered.length > 0) {
    selectNote(state.selectedIndex);
  } else {
    showEmpty();
  }
}

function renderList() {
  noteListEl.innerHTML = "";
  countEl.textContent = `${state.filtered.length}/${state.notes.length}`;

  state.filtered.forEach((note, idx) => {
    const item = document.createElement("div");
    item.className = "note-item" + (idx === state.selectedIndex ? " selected" : "");
    item.textContent = note.title;
    item.title = note.path;
    item.onclick = () => {
      state.selectedIndex = idx;
      selectNote(idx);
      renderList();
    };
    noteListEl.appendChild(item);
  });
}

async function selectNote(index: number) {
  if (index < 0 || index >= state.filtered.length) return;

  state.selectedIndex = index;
  const note = state.filtered[index];
  state.currentNotePath = note.path;
  currentImages = [];
  focusedImageIdx = 0;

  titleEl.textContent = note.title;
  tagsEl.textContent = note.tags.length ? note.tags.map((t) => `#${t}`).join(" ") : "";

  const raw = await invoke<string>("get_note_markdown", { path: note.path });
  renderPreview(raw, note.path);

  renderList(); // update selection highlight
}

function showEmpty() {
  titleEl.textContent = "";
  tagsEl.textContent = "";
  previewEl.innerHTML = `<p style="color:#858585">No notes match the filter.</p>`;
}

function preprocessMath(md: string): string {
  // Replace display math $$...$$ with a marker span (trusted content)
  let out = md.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr) => {
    const safe = expr.trim().replace(/"/g, "&quot;");
    return `<span class="math-display" data-latex="${safe}"></span>`;
  });

  // Inline $...$ (avoid $$ already handled)
  out = out.replace(/(^|[^$])\$([^\s$][^$\n]*?)\$/g, (_m, prefix, expr) => {
    const safe = expr.trim().replace(/"/g, "&quot;");
    return `${prefix}<span class="math-inline" data-latex="${safe}"></span>`;
  });

  return out;
}

function postRenderMath(container: HTMLElement) {
  // Display math
  container.querySelectorAll<HTMLElement>(".math-display").forEach((el) => {
    const latex = el.getAttribute("data-latex") || "";
    if (!latex) return;
    try {
      el.innerHTML = katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
      });
    } catch (e) {
      el.textContent = `$$${latex}$$`;
    }
  });

  // Inline math
  container.querySelectorAll<HTMLElement>(".math-inline").forEach((el) => {
    const latex = el.getAttribute("data-latex") || "";
    if (!latex) return;
    try {
      el.innerHTML = katex.renderToString(latex, {
        displayMode: false,
        throwOnError: false,
      });
    } catch (e) {
      el.textContent = `$${latex}$`;
    }
  });
}

async function rewriteImages(container: HTMLElement, noteRelativePath: string) {
  // Get vault root once (absolute path from Rust)
  let vaultRoot: string;
  try {
    vaultRoot = await invoke<string>("get_vault_root_cmd");
  } catch {
    // Fallback for some dev scenarios
    vaultRoot = "vault";
  }

  const imgs = container.querySelectorAll<HTMLImageElement>("img");
  imgs.forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("http") || src.startsWith("data:")) return;

    // Typical: ../images/foo.jpg or ./images/ or images/
    let filename = src.split("/").pop() || src;
    // Remove query etc
    filename = filename.split("?")[0];

    // Build absolute disk path: vaultRoot + /images + filename
    const fullPath = `${vaultRoot}/images/${filename}`;
    const tauriSrc = convertFileSrc(fullPath);
    img.src = tauriSrc;

    // Make clickable to open externally
    img.onclick = async (e) => {
      e.stopImmediatePropagation();
      try {
        await invoke("open_path", { path: fullPath });
      } catch {
        // ignore
      }
    };
  });
}

function renderPreview(rawMarkdown: string, noteRelativePath: string) {
  const withoutFrontmatter = rawMarkdown.replace(/^---[\s\S]*?---\s*/, "");
  const preprocessed = preprocessMath(withoutFrontmatter);

  const html = marked.parse(preprocessed) as string;

  // Notes are untrusted input — strip scripts/handlers before inserting.
  // data-latex spans survive (data-* attrs are kept) for postRenderMath.
  previewEl.innerHTML = DOMPurify.sanitize(html);

  // Enhance
  postRenderMath(previewEl);
  rewriteImages(previewEl, noteRelativePath).catch(() => {});

  // Make tables nicer
  previewEl.querySelectorAll("table").forEach((t) => t.classList.add("md-table"));
}

async function loadAllNotes() {
  try {
    const notes = await invoke<NoteInfo[]>("load_notes");
    state.notes = notes;
    state.filtered = [...notes];
    state.selectedIndex = 0;
    renderList();

    if (state.filtered.length > 0) {
      await selectNote(0);
    } else {
      showEmpty();
    }
  } catch (e) {
    previewEl.innerHTML = `<p style="color:#ff8080">Failed to load vault: ${e}</p>`;
  }
}

function setupSearch() {
  searchEl.addEventListener("input", () => {
    state.searchQuery = searchEl.value;
    applyFilter();
  });

  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (state.filtered.length > 0) {
        selectNote(state.selectedIndex);
      }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.selectedIndex = Math.min(state.selectedIndex + 1, state.filtered.length - 1);
      renderList();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
      renderList();
    }
  });
}

function setupKeyboard() {
  document.addEventListener("keydown", async (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (e.key === "Escape") {
        (e.target as HTMLInputElement).blur();
        searchEl.blur();
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case "/":
        e.preventDefault();
        searchEl.focus();
        searchEl.select();
        break;
      case "r":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          await loadAllNotes();
        }
        break;
      case "arrowdown":
      case "j":
        e.preventDefault();
        if (state.filtered.length) {
          state.selectedIndex = Math.min(state.selectedIndex + 1, state.filtered.length - 1);
          await selectNote(state.selectedIndex);
        }
        break;
      case "arrowup":
      case "k":
        e.preventDefault();
        if (state.filtered.length) {
          state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
          await selectNote(state.selectedIndex);
        }
        break;
      case " ":
        e.preventDefault();
        previewEl.scrollBy(0, 120);
        break;
      case "b":
        previewEl.scrollBy(0, -120);
        break;
      case "[":
      case "]":
        await cycleImage(e.key === "]");
        break;
      case "o":
        await openCurrentImage();
        break;
      case "q":
        // In desktop app, we can't really quit from here easily, ignore or window close
        break;
      case "escape":
        // blur search etc
        searchEl.blur();
        break;
    }
  });
}

async function cycleImage(forward: boolean) {
  if (currentImages.length === 0) {
    // scan current preview for images
    currentImages = Array.from(previewEl.querySelectorAll("img")).map((img) => {
      // the src is already converted, but we stored original full path? hack: use data or rebuild
      // For simplicity, re-extract from the note content is overkill.
      // Instead store last known image paths when rewriting.
      return img.src;
    });
    focusedImageIdx = 0;
  }
  if (currentImages.length === 0) return;

  focusedImageIdx = forward
    ? (focusedImageIdx + 1) % currentImages.length
    : (focusedImageIdx - 1 + currentImages.length) % currentImages.length;

  const targetSrc = currentImages[focusedImageIdx];
  const imgs = Array.from(previewEl.querySelectorAll("img"));
  const target = imgs.find((i) => i.src === targetSrc) || imgs[focusedImageIdx];

  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    // brief highlight
    target.style.outline = "2px solid #3794ff";
    setTimeout(() => (target.style.outline = ""), 900);
  }
}

async function openCurrentImage() {
  // Try to open first visible image or last cycled
  const imgs = Array.from(previewEl.querySelectorAll("img"));
  if (imgs.length === 0) return;

  let pathToOpen = "";
  // Best effort: try to get original file path by asking backend for current note images
  // For simplicity call a command
  try {
    if (state.currentNotePath) {
      const images = await invoke<string[]>("get_note_images", { path: state.currentNotePath });
      if (images.length > 0) {
        pathToOpen = images[0];
      }
    }
  } catch {}

  if (!pathToOpen && imgs[0]) {
    // last resort: the src is tauri asset url, not usable for open. Skip.
    return;
  }
  if (pathToOpen) {
    await invoke("open_path", { path: pathToOpen });
  }
}

function setupButtons() {
  const reloadBtn = document.getElementById("reload-btn")!;
  reloadBtn.onclick = async () => {
    await loadAllNotes();
  };

  // Mouse wheel already works on preview
}

async function init() {
  noteListEl = document.getElementById("note-list") as HTMLDivElement;
  previewEl = document.getElementById("preview") as HTMLDivElement;
  searchEl = document.getElementById("search") as HTMLInputElement;
  titleEl = document.getElementById("note-title") as HTMLSpanElement;
  tagsEl = document.getElementById("note-tags") as HTMLSpanElement;
  countEl = document.getElementById("count") as HTMLSpanElement;

  setupMarked();
  setupSearch();
  setupKeyboard();
  setupButtons();

  // Initial load
  await loadAllNotes();

  // Focus list initially
  noteListEl.focus();
}

// Boot
init().catch(console.error);
