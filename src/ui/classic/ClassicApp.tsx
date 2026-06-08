import { useCallback, useEffect, useRef, useState } from "react";
import { CHAINS, type ChainKey } from "../../chains";
import { parseUri } from "../../resolver/uri";
import { buildArtworkUrlSuffix } from "../../url-params";
import { type ArtworkItem } from "../../discovery";
import { createArchive } from "../../archive";
import {
  type ProjectFile,
  type ProjectIndexEntry,
  thumbnailUrl,
  buildIframeSrc,
  projectFileToItems,
  loadSavedProjectItems,
} from "../../viewer/artwork";

type Mode = "uri" | "file";

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; iframeSrc: string; uri: string };

interface FormState {
  mode: Mode;
  chain: ChainKey;
  uri: string;
  fxhash: string;
  iteration: string;
  minter: string;
}

// Default values pre-filled with the Genomes #1196 onchfs artwork so the
// user can immediately test the onchfs path without having to type anything.
const DEMO: FormState = {
  mode: "file",
  chain: "ethereum",
  uri: "onchfs://046f4712c2aaa344f82f1ef8ffed2ab8c9714819228e29c6a28cf67b14377f61",
  fxhash: "0xdd9b8e6407bb9ac960d7ae7986fcb0470691398a84a9e84b0995d2c2bdf9397f",
  iteration: "1196",
  minter: "0x8A05e5EEcaB2C1b5dfAf26CF11c9845bF971fB45",
};

type FileLoadState =
  | { kind: "idle" }
  | { kind: "error"; message: string }
  | { kind: "ready"; projectName: string; items: ArtworkItem[] };

export function ClassicApp() {
  const [form, setForm] = useState<FormState>(DEMO);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fileLoad, setFileLoad] = useState<FileLoadState>({ kind: "idle" });
  const [projectIndex, setProjectIndex] = useState<ProjectIndexEntry[]>([]);
  const [projectListExpanded, setProjectListExpanded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Fetch the saved projects index when app loads
  useEffect(() => {
    fetch("/projects/_index.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (Array.isArray(data)) setProjectIndex(data);
      })
      .catch(() => {
        // No index file yet — that's fine, user hasn't extracted any projects
      });
  }, []);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);

  // Keep our fullscreen flag in sync with the actual browser state, since
  // the user can exit fullscreen via the Esc key without touching our button.
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      viewerRef.current?.requestFullscreen?.().catch(() => {
        // Some browsers reject fullscreen requests outside trusted user
        // gestures or when the sandbox blocks it. Failing silently is fine.
      });
    } else {
      document.exitFullscreen?.();
    }
  }, []);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const load = useCallback(async () => {
    try {
      const uri = form.uri.trim();
      if (!uri) throw new Error("Please paste an onchfs:// or ipfs:// URI.");

      setStatus({ kind: "loading", message: `Resolving ${uri}...` });

      const parsed = parseUri(uri);
      const suffix = buildArtworkUrlSuffix({
        cid: uri,
        fxhash: form.fxhash,
        iteration: Number(form.iteration) || 0,
        minter: form.minter || undefined,
        chain: form.chain,
      });

      const iframeSrc = buildIframeSrc(parsed, suffix, form.chain);
      setStatus({ kind: "ready", iframeSrc, uri });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  }, [form]);

  /**
   * When the user clicks an artwork from a project list, load it directly.
   */
  const selectItem = useCallback(
    async (item: ArtworkItem) => {
      setForm((f) => ({
        ...f,
        chain: item.chain,
        uri: item.generativeUri,
        fxhash: item.fxhash,
        iteration: String(item.iteration),
        minter: item.minter,
      }));

      // Trigger load with the item's data directly, without waiting for the
      // form-controlled load() to see the new state.
      try {
        if (!item.generativeUri) {
          throw new Error(
            "This artwork doesn't have a generative URI from the discovery source. " +
              "Try fetching with full metadata, or use URI Mode directly.",
          );
        }
        setStatus({ kind: "loading", message: `Resolving ${item.generativeUri}...` });
        const parsed = parseUri(item.generativeUri);
        const suffix = buildArtworkUrlSuffix({
          cid: item.generativeUri,
          fxhash: item.fxhash,
          iteration: item.iteration,
          minter: item.minter || undefined,
          chain: item.chain,
          inputBytes: item.fxparams || undefined,
        });
        const iframeSrc = buildIframeSrc(parsed, suffix, item.chain);
        setStatus({ kind: "ready", iframeSrc, uri: item.generativeUri });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: "error", message });
      }
    },
    [],
  );

  const [archiveStatus, setArchiveStatus] = useState<string>("");

  const archive = useCallback(async () => {
    if (status.kind !== "ready") return;
    setArchiveStatus("Archiving...");
    try {
      const count = await createArchive({
        uri: status.uri,
        fxhash: form.fxhash,
        iteration: Number(form.iteration) || 0,
        minter: form.minter,
        name: `artwork-${form.iteration}`,
      });
      setArchiveStatus(`Archived ${count} file(s).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setArchiveStatus(`Archive failed: ${msg}`);
    }
  }, [status, form]);

  /**
   * Store the selected file for later processing.
   */
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedFile(e.target.files?.[0] ?? null);
    setFileLoad({ kind: "idle" });
  }, []);

  /**
   * Load a project directly from the saved projects folder (public/projects/).
   */
  const loadSavedProject = useCallback(async (filename: string) => {
    try {
      const { projectName, items } = await loadSavedProjectItems(filename);
      setFileLoad({ kind: "ready", projectName, items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFileLoad({ kind: "error", message: msg });
    }
  }, []);

  /**
   * Read and parse the selected project JSON file.
   *
   * Supports two formats:
   *   1. extract-project.mjs output: { project, iterations[] }
   *   2. Raw fxhash metadata JSON: { generativeUri, artifactUri, ... }
   *      (single iteration only, but lets users skip the extraction step)
   */
  const loadFile = useCallback(() => {
    if (!selectedFile) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);

        // Format 1: extract-project.mjs output
        if (raw.iterations && Array.isArray(raw.iterations)) {
          const data = raw as ProjectFile;
          setFileLoad({
            kind: "ready",
            projectName: data.project?.name ?? selectedFile.name,
            items: projectFileToItems(data),
          });
          return;
        }

        // Format 2: Raw fxhash metadata JSON (single artwork)
        const uri = raw.generativeUri || raw.generatorUri || "";
        const artifactUri = raw.artifactUri || raw.animation_url || "";
        if (uri || artifactUri) {
          // Parse fxhash params from artifactUri query string
          let fxhash = raw.iterationHash || raw.previewHash || "";
          let iteration = raw.previewIteration ?? 0;
          let minter = raw.previewMinter || "";

          const qsMatch = artifactUri.match(/\?(.+)$/);
          if (qsMatch) {
            const params = new URLSearchParams(qsMatch[1]);
            fxhash = fxhash || params.get("fxhash") || "";
            iteration = iteration || parseInt(params.get("fxiteration") || "0");
            minter = minter || params.get("fxminter") || "";
          }

          // Extract fxparams from artifactUri or previewInputBytes
          const rawFxparams = (() => {
            if (qsMatch) {
              const p = new URLSearchParams(qsMatch[1]).get("fxparams");
              if (p) return p;
            }
            return raw.previewInputBytes || "";
          })();

          const name = raw.name || "Unknown artwork";
          const item: ArtworkItem = {
            key: `ethereum:raw:0`,
            name,
            projectName: name,
            artistName: "",
            thumbnailUri: raw.thumbnailUri || raw.displayUri || raw.image || "",
            generativeUri: uri || artifactUri.split("?")[0],
            fxhash,
            iteration,
            minter,
            fxparams: rawFxparams,
            chain: "ethereum",
            contract: "0x0000000000000000000000000000000000000000",
            tokenId: "0",
          source: "graphql" as const,
          };

          setFileLoad({
            kind: "ready",
            projectName: name,
            items: [item],
          });
          return;
        }

        throw new Error(
          "Unrecognized JSON format. Expected either:\n" +
          "• extract-project.mjs output (has 'iterations' array)\n" +
          "• fxhash metadata JSON (has 'generativeUri' or 'artifactUri')",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFileLoad({ kind: "error", message: msg });
      }
    };
    reader.readAsText(selectedFile);
  }, [selectedFile]);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">fxhash viewer</h1>
        <span className="app__subtitle">fxhash-independent generative art viewer</span>
      </header>

      <div className={`app__body ${sidebarCollapsed ? "app__body--collapsed" : ""}`}>
        <aside className="sidebar" aria-hidden={sidebarCollapsed}>
          <div className="field">
            <label className="field__label">Mode</label>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => update("mode", "file")}
                style={{
                  flex: 1,
                  borderColor: form.mode === "file" ? "var(--accent)" : "var(--border)",
                  background: form.mode === "file" ? "var(--accent)" : "transparent",
                  color: form.mode === "file" ? "var(--bg)" : "var(--accent)",
                }}
              >
                File
              </button>
              <button
                onClick={() => update("mode", "uri")}
                style={{
                  flex: 1,
                  borderColor: form.mode === "uri" ? "var(--accent)" : "var(--border)",
                  background: form.mode === "uri" ? "var(--accent)" : "transparent",
                  color: form.mode === "uri" ? "var(--bg)" : "var(--accent)",
                }}
              >
                URI
              </button>
            </div>
          </div>

          {form.mode === "uri" && (
            <div className="field">
              <label className="field__label" htmlFor="chain">Chain</label>
              <select
                id="chain"
                value={form.chain}
                onChange={(e) => update("chain", e.target.value as ChainKey)}
              >
                {Object.values(CHAINS).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          {form.mode === "uri" && (
            <div className="field">
              <label className="field__label" htmlFor="uri">URI (onchfs:// or ipfs://)</label>
              <input
                id="uri"
                type="text"
                value={form.uri}
                onChange={(e) => update("uri", e.target.value)}
                placeholder="onchfs://..."
                spellCheck={false}
              />
            </div>
          )}


          {form.mode === "file" && (
            <>
              {projectIndex.length > 0 && (
                <div className="field">
                  <label className="field__label">Saved Projects</label>
                  <div className="project-list">
                    {(projectListExpanded ? projectIndex : projectIndex.slice(0, 5)).map((p) => (
                      <button
                        key={p.filename}
                        className="project-list__item"
                        onClick={() => loadSavedProject(p.filename)}
                      >
                        <span className="project-list__name">{p.name}</span>
                        <span className="project-list__info">{p.chain} · {p.count} iter</span>
                      </button>
                    ))}
                    {projectIndex.length > 5 && (
                      <button
                        className="project-list__toggle"
                        onClick={() => setProjectListExpanded((v) => !v)}
                      >
                        {projectListExpanded
                          ? "Show less"
                          : `+ ${projectIndex.length - 5} more`}
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="field">
                <label className="field__label">Or load from file</label>
                <input
                  type="file"
                  accept=".json"
                  onChange={handleFileSelect}
                  style={{ fontSize: 11 }}
                />
              </div>

              {selectedFile && (
                <button onClick={loadFile}>
                  Load File
                </button>
              )}

              {fileLoad.kind === "error" && (
                <div className="status status--error">
                  <span className="status__label">Error</span>
                  {fileLoad.message}
                </div>
              )}

              {fileLoad.kind === "ready" && (
                <div className="discovery-results">
                  <div className="status">
                    <span className="status__label">{fileLoad.projectName}</span>
                    {fileLoad.items.length} iteration(s) loaded.
                  </div>

                  <div className="artwork-grid">
                    {fileLoad.items.map((item) => (
                      <button
                        key={item.key}
                        className="artwork-card"
                        onClick={() => selectItem(item)}
                        title={item.name}
                      >
                        {item.thumbnailUri ? (
                          <img
                            className="artwork-card__thumb"
                            src={thumbnailUrl(item.thumbnailUri)}
                            alt={item.name}
                            loading="lazy"
                          />
                        ) : (
                          <div className="artwork-card__thumb artwork-card__thumb--empty">
                            <span>no preview</span>
                          </div>
                        )}
                        <div className="artwork-card__meta">
                          <div className="artwork-card__name">{item.name}</div>
                          <div className="artwork-card__sub">iter {item.iteration}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {form.mode === "uri" && (
            <>
              <div className="field">
                <label className="field__label" htmlFor="fxhash">fxhash (RNG seed)</label>
                <input
                  id="fxhash"
                  type="text"
                  value={form.fxhash}
                  onChange={(e) => update("fxhash", e.target.value)}
                  spellCheck={false}
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="iteration">Iteration</label>
                <input
                  id="iteration"
                  type="text"
                  value={form.iteration}
                  onChange={(e) => update("iteration", e.target.value)}
                  spellCheck={false}
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="minter">Minter (optional)</label>
                <input
                  id="minter"
                  type="text"
                  value={form.minter}
                  onChange={(e) => update("minter", e.target.value)}
                  placeholder="0x..."
                  spellCheck={false}
                />
              </div>

              <button onClick={load} disabled={status.kind === "loading"}>
                {status.kind === "loading" ? "..." : "Load"}
              </button>
            </>
          )}

          {status.kind === "loading" && (
            <div className="status">
              <span className="status__label">Status</span>
              {status.message}
            </div>
          )}

          {status.kind === "error" && (
            <div className="status status--error">
              <span className="status__label">Error</span>
              {status.message}
            </div>
          )}

          {status.kind === "ready" && (
            <div className="status">
              <span className="status__label">Loaded</span>
              <div className="meta">
                <span className="meta__key">uri</span>
                <span className="meta__val">{status.uri}</span>
              </div>
            </div>
          )}

          {status.kind === "ready" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button onClick={archive}>Archive (ZIP)</button>
              {archiveStatus && (
                <div className="status" style={{ fontSize: 11 }}>
                  {archiveStatus}
                </div>
              )}
            </div>
          )}
        </aside>

        <button
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed((v) => !v)}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>

        <main className="viewer" ref={viewerRef}>
          {status.kind === "ready" ? (
            <>
              <iframe
                className="viewer__iframe"
                src={status.iframeSrc}
                sandbox="allow-scripts allow-same-origin"
                allow="fullscreen"
                title="generative artwork"
              />
              <button
                className="viewer__fullscreen"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                  {isFullscreen ? (
                    // exit-fullscreen glyph (arrows pointing inward)
                    <path d="M8 3v3H5v2h5V3H8zm6 0v5h5V6h-3V3h-2zM3 14h5v5H6v-3H3v-2zm13 0h5v2h-3v3h-2v-5z" />
                  ) : (
                    // enter-fullscreen glyph (arrows pointing outward)
                    <path d="M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM3 14h2v5h5v2H3v-7zm16 0h2v7h-7v-2h5v-5z" />
                  )}
                </svg>
              </button>
            </>
          ) : (
            <div className="viewer__placeholder">
              {status.kind === "idle" ? "load an artwork to begin" : null}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
