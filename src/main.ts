import { invoke } from "@tauri-apps/api/core";
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
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
  for (const img of imgs) {
    const original = img.getAttribute("src") || "";
    if (!original || /^(https?:|data:)/i.test(original)) continue;

    img.setAttribute("data-original-src", original);
    try {
      // Backend reads the file and returns a base64 data URL. Embedding the
      // bytes works the same on macOS and Windows, unlike file paths routed
      // through the asset protocol.
      img.src = await invoke<string>("read_image_data_url", {
        notePath: noteRelativePath,
        src: original,
      });
    } catch {
      // leave the unresolved image as-is
    }

    img.style.cursor = "pointer";
    img.onclick = async (e) => {
      e.stopImmediatePropagation();
      try {
        await invoke("open_note_image", { notePath: noteRelativePath, src: original });
      } catch {
        // ignore
      }
    };
  }
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
  const imgs = Array.from(previewEl.querySelectorAll<HTMLImageElement>("img"));
  if (imgs.length === 0) return;

  focusedImageIdx = forward
    ? (focusedImageIdx + 1) % imgs.length
    : (focusedImageIdx - 1 + imgs.length) % imgs.length;

  const target = imgs[focusedImageIdx];
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.style.outline = "2px solid #3794ff";
  setTimeout(() => (target.style.outline = ""), 900);
}

async function openCurrentImage() {
  if (!state.currentNotePath) return;
  const imgs = Array.from(previewEl.querySelectorAll<HTMLImageElement>("img"));
  const target = imgs[focusedImageIdx] || imgs[0];
  const original = target?.getAttribute("data-original-src");
  if (!original) return;
  try {
    await invoke("open_note_image", { notePath: state.currentNotePath, src: original });
  } catch {
    // ignore
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
