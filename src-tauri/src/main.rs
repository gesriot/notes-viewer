// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{command, Manager};
use tauri_plugin_opener::OpenerExt;
use walkdir::WalkDir;

static FRONTMATTER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?s)^---\s*\n(.*?)\n---\s*\n?(.*)$").unwrap()
});

static TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"tags:\s*\[([^\]]*)\]|tags:\s*(.+)"#).unwrap());

#[derive(Debug, Serialize, Deserialize, Clone)]
struct NoteInfo {
    path: String, // relative like "notes/01-foo.md"
    title: String,
    tags: Vec<String>,
}

fn get_vault_root(app: &tauri::AppHandle) -> PathBuf {
    // Prefer resource dir (for bundled), fallback to cwd + vault for dev.
    // Tauri encodes the `../vault` resource path as `_up_/vault` inside the
    // bundle, so check both layouts.
    if let Ok(res) = app.path().resource_dir() {
        for candidate in [res.join("vault"), res.join("_up_").join("vault")] {
            if candidate.join("notes").exists() {
                return candidate;
            }
        }
    }
    // Dev fallback: current working dir + vault
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("vault")
}

/// Resolve a vault-relative path to an absolute path, rejecting anything that
/// escapes the vault (e.g. `../../etc/passwd`).
fn resolve_in_vault(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let canon_vault = vault
        .canonicalize()
        .map_err(|e| format!("vault not accessible: {e}"))?;
    let canon = vault
        .join(rel)
        .canonicalize()
        .map_err(|e| format!("path not accessible: {e}"))?;
    if !canon.starts_with(&canon_vault) {
        return Err("refused: path is outside the vault".into());
    }
    Ok(canon)
}

fn parse_frontmatter_and_title(raw: &str, default_title: &str) -> (Vec<String>, String) {
    let mut tags = Vec::new();
    let mut title = default_title.to_string();

    if let Some(caps) = FRONTMATTER_RE.captures(raw) {
        let fm = caps.get(1).map(|m| m.as_str()).unwrap_or("");

        // title
        if let Some(t) = fm
            .lines()
            .find(|l| l.trim_start().starts_with("title:"))
        {
            let t = t.split_once(':').map(|(_, v)| v.trim().trim_matches('"').trim_matches('\'').to_string());
            if let Some(v) = t { title = v; }
        }

        // tags: [a, b] or tags: a,b
        if let Some(c) = TAG_RE.captures(fm) {
            if let Some(list) = c.get(1) {
                tags = list
                    .as_str()
                    .split(',')
                    .map(|s| s.trim().trim_matches('"').trim_matches('\'').trim_matches('[').trim_matches(']').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            } else if let Some(single) = c.get(2) {
                tags = single
                    .as_str()
                    .split(|c: char| c == ',' || c.is_whitespace())
                    .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
    }

    if title == default_title {
        // fallback from first heading
        if let Some(line) = raw.lines().find(|l| l.starts_with('#')) {
            title = line.trim_start_matches('#').trim().to_string();
        }
    }

    (tags, title)
}

#[command]
fn load_notes(app: tauri::AppHandle) -> Result<Vec<NoteInfo>, String> {
    let vault = get_vault_root(&app);
    let notes_dir = vault.join("notes");

    if !notes_dir.exists() {
        return Ok(vec![]);
    }

    let mut notes: Vec<NoteInfo> = Vec::new();

    for entry in WalkDir::new(&notes_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let rel = path
            .strip_prefix(&vault)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let content = fs::read_to_string(path).unwrap_or_default();
        let filename_title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .replace(['-', '_'], " ");

        let (tags, title) = parse_frontmatter_and_title(&content, &filename_title);

        notes.push(NoteInfo {
            path: rel,
            title,
            tags,
        });
    }

    notes.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(notes)
}

#[command]
fn get_note_markdown(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let vault = get_vault_root(&app);
    let full = resolve_in_vault(&vault, &path)?;
    fs::read_to_string(&full).map_err(|e| format!("failed to read {}: {}", full.display(), e))
}

#[command]
fn get_vault_root_cmd(app: tauri::AppHandle) -> Result<String, String> {
    Ok(get_vault_root(&app).to_string_lossy().to_string())
}

#[command]
fn get_note_images(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    let vault = get_vault_root(&app);
    let full = resolve_in_vault(&vault, &path)?;
    let canon_vault = vault.canonicalize().map_err(|e| e.to_string())?;
    let content = fs::read_to_string(&full).unwrap_or_default();

    // very simple image extractor for ../images/xxx or images/xxx
    let img_re = Regex::new(r"!\[[^\]]*\]\(([^)]+)\)").unwrap();
    let mut images = Vec::new();

    for cap in img_re.captures_iter(&content) {
        if let Some(href) = cap.get(1) {
            let href = href.as_str().trim();
            if href.contains("://") { continue; }

            let img_path = if href.starts_with("../images/") || href.starts_with("images/") {
                let file = href.split('/').last().unwrap_or(href);
                vault.join("images").join(file)
            } else {
                // resolve relative to note
                let note_dir = full.parent().unwrap_or(&vault);
                note_dir.join(href)
            };

            // Only surface images that actually resolve inside the vault.
            if let Ok(canon) = img_path.canonicalize() {
                if canon.starts_with(&canon_vault) {
                    images.push(canon.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(images)
}

#[command]
async fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Only allow opening files that live inside the vault.
    let vault = get_vault_root(&app);
    let canon_vault = vault.canonicalize().map_err(|e| e.to_string())?;
    let canon = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !canon.starts_with(&canon_vault) {
        return Err("refused: path is outside the vault".into());
    }
    app.opener()
        .open_path(canon.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[command]
fn get_note_list_for_debug(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    // helper if needed
    let notes = load_notes(app)?;
    Ok(notes.into_iter().map(|n| n.path).collect())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_notes,
            get_note_markdown,
            get_vault_root_cmd,
            get_note_images,
            open_path,
            get_note_list_for_debug
        ])
        .setup(|app| {
            // Log vault for debugging
            let vault = get_vault_root(&app.handle());
            println!("[notes-viewer] Vault root: {}", vault.display());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
