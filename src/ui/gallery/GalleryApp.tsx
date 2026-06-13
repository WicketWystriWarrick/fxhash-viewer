import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent,
  type CSSProperties,
} from "react";
import type { ArtworkItem } from "../../discovery";
import {
  type ProjectIndexEntry,
  thumbnailUrl,
  itemToIframeSrc,
  loadSavedProjectItems,
} from "../../viewer/artwork";

/**
 * Gallery UI (v2). Three full-screen screens:
 *   gallery → one representative thumbnail per project
 *   tiles   → every iteration of the chosen project, as a tile grid
 *   live    → the chosen artwork running full-screen
 *
 * All loading/rendering reuses the shared viewer helpers, so an artwork
 * resolves exactly as it does in the classic UI.
 */
type Screen =
  | { name: "gallery" }
  | {
      name: "tiles";
      project: ProjectIndexEntry;
      loading: boolean;
      error?: string;
      items: ArtworkItem[];
    }
  | { name: "live"; item: ArtworkItem; iframeSrc: string; project: ProjectIndexEntry };

export function GalleryApp() {
  const [projects, setProjects] = useState<ProjectIndexEntry[]>([]);
  const [indexError, setIndexError] = useState<string>("");
  const [screen, setScreen] = useState<Screen>({ name: "gallery" });

  useEffect(() => {
    fetch("/projects/_index.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (Array.isArray(data)) {
          // Stable display order: by name.
          setProjects(
            [...data].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
          );
        }
      })
      .catch(() => {
        setIndexError(
          "No saved projects found. Run the extract scripts to populate public/projects/, " +
            "or use the classic UI's URI mode.",
        );
      });
  }, []);

  const openProject = useCallback(async (project: ProjectIndexEntry) => {
    setScreen({ name: "tiles", project, loading: true, items: [] });
    try {
      const { items } = await loadSavedProjectItems(project.filename);
      setScreen({ name: "tiles", project, loading: false, items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setScreen({ name: "tiles", project, loading: false, items: [], error: msg });
    }
  }, []);

  const openLive = useCallback((item: ArtworkItem, project: ProjectIndexEntry) => {
    try {
      const { iframeSrc } = itemToIframeSrc(item);
      setScreen({ name: "live", item, iframeSrc, project });
    } catch (err) {
      // Stay on tiles; surface the error there.
      const msg = err instanceof Error ? err.message : String(err);
      setScreen((s) =>
        s.name === "tiles" ? { ...s, error: msg } : s,
      );
    }
  }, []);

  if (screen.name === "gallery") {
    return (
      <ProjectGallery
        projects={projects}
        error={indexError}
        onOpen={openProject}
      />
    );
  }

  if (screen.name === "tiles") {
    return (
      <ProjectTiles
        screen={screen}
        onBack={() => setScreen({ name: "gallery" })}
        onOpenLive={(item) => openLive(item, screen.project)}
      />
    );
  }

  return (
    <LiveView
      screen={screen}
      onBack={() => openProject(screen.project)}
    />
  );
}

/* ------------------------------ Screen 1 ------------------------------ */

function ProjectGallery({
  projects,
  error,
  onOpen,
}: {
  projects: ProjectIndexEntry[];
  error: string;
  onOpen: (p: ProjectIndexEntry) => void;
}) {
  // Click an artist chip to filter the grid down to that artist's projects.
  // A project lists each artist separately, so a collaborator's chip also
  // surfaces their solo works (and vice-versa).
  const artistsOf = (p: ProjectIndexEntry): string[] =>
    p.artists && p.artists.length ? p.artists : p.artist ? [p.artist] : [];
  const [artistFilter, setArtistFilter] = useState<string>("");
  const visible = artistFilter
    ? projects.filter((p) => artistsOf(p).includes(artistFilter))
    : projects;

  return (
    <div className="gallery">
      <header className="gallery__header">
        <h1 className="gallery__title">fxhash viewer</h1>
        <span className="gallery__count">
          {visible.length} project(s){artistFilter ? ` · ${visible.length} of ${projects.length}` : ""}
        </span>
      </header>

      {artistFilter && (
        <div className="gallery__filter">
          <span>
            Artist: <strong>{artistFilter}</strong>
          </span>
          <button className="chip chip--clear" onClick={() => setArtistFilter("")}>
            clear ✕
          </button>
        </div>
      )}

      {error && projects.length === 0 ? (
        <div className="gallery__empty">{error}</div>
      ) : (
        <div className="gallery__grid">
          {visible.map((p) => (
            <div key={p.filename} className="gallery-card">
              <button
                className="gallery-card__open"
                onClick={() => onOpen(p)}
                title={p.name}
              >
                {p.thumbnail ? (
                  <img
                    className="gallery-card__thumb"
                    src={thumbnailUrl(p.thumbnail)}
                    alt={p.name}
                    loading="lazy"
                  />
                ) : (
                  <div className="gallery-card__thumb gallery-card__thumb--empty">
                    <span>no preview</span>
                  </div>
                )}
                <span className="gallery-card__name">{p.name}</span>
                <span className="gallery-card__chain">{p.chain}</span>
              </button>
              <div className="gallery-card__tags">
                {artistsOf(p).map((a) => (
                  <button
                    key={a}
                    className="chip chip--artist"
                    title={`Filter by ${a}`}
                    onClick={() => setArtistFilter(a)}
                  >
                    {a}
                  </button>
                ))}
                <span className="gallery-card__count">{p.count}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Screen 2 ------------------------------ */

function ProjectTiles({
  screen,
  onBack,
  onOpenLive,
}: {
  screen: Extract<Screen, { name: "tiles" }>;
  onBack: () => void;
  onOpenLive: (item: ArtworkItem) => void;
}) {
  // A project's iterations all share one thumbnail size. Measure it from the
  // first image that loads to get the aspect ratio (h / w).
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const onThumbLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    if (dims) return;
    const im = e.currentTarget;
    if (im.naturalWidth && im.naturalHeight) setDims({ w: im.naturalWidth, h: im.naturalHeight });
  };
  const ratio = dims ? dims.h / dims.w : 4 / 3; // h / w (default 3:4 portrait)

  // Give every tile an explicit pixel height = (responsive column width) ×
  // ratio. We compute it in JS because CSS aspect-ratio / padding-top both
  // collapse to a thin strip inside this grid + lazy-load combination. The
  // column width is read from a rendered tile and re-read on resize.
  const gridRef = useRef<HTMLDivElement>(null);
  const [colW, setColW] = useState(0);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const tile = el.querySelector<HTMLElement>(".tile");
      if (tile) setColW(tile.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [screen.loading, screen.items.length]);
  const tileStyle: CSSProperties | undefined =
    colW > 0 ? { height: Math.round(colW * ratio) } : undefined;
  return (
    <div className="tiles">
      <header className="tiles__bar">
        <button className="backbtn" onClick={onBack}>
          ‹ Projects
        </button>
        <div className="tiles__titlewrap">
          <span className="tiles__title">{screen.project.name}</span>
          <span className="tiles__sub">
            {screen.project.artist ? `${screen.project.artist} · ` : ""}
            {screen.loading ? "loading…" : `${screen.items.length} iteration(s)`}
          </span>
        </div>
      </header>

      {screen.error ? (
        <div className="tiles__empty">Error: {screen.error}</div>
      ) : screen.loading ? (
        <div className="tiles__empty">Loading project…</div>
      ) : (
        <div className="tiles__grid" ref={gridRef}>
          {screen.items.map((item) => (
            <button
              key={item.key}
              className="tile"
              style={tileStyle}
              onClick={() => onOpenLive(item)}
              title={item.name}
            >
              {item.thumbnailUri ? (
                <img
                  className="tile__thumb"
                  src={thumbnailUrl(item.thumbnailUri)}
                  alt={item.name}
                  loading="lazy"
                  onLoad={onThumbLoad}
                />
              ) : (
                <div className="tile__thumb tile__thumb--empty">
                  <span>no preview</span>
                </div>
              )}
              <span className="tile__label">#{item.iteration}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Screen 3 ------------------------------ */

function LiveView({
  screen,
  onBack,
}: {
  screen: Extract<Screen, { name: "live" }>;
  onBack: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // "armed" = all controls visible for a few seconds, then they fade away so
  // the artwork is shown unobstructed. Re-armed on entry and on every
  // fullscreen toggle, giving the viewer a moment to orient each time.
  const [armed, setArmed] = useState(true);

  useEffect(() => {
    setArmed(true);
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [isFullscreen]);

  // The global Classic/Gallery switch (rendered by App) overlaps the art and
  // isn't one of the two controls we keep, so hide it while an artwork plays.
  useEffect(() => {
    document.body.classList.add("live-active");
    return () => document.body.classList.remove("live-active");
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Esc returns to the tile grid (when not in browser-fullscreen).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      stageRef.current?.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  }, []);

  return (
    <div className={`live${armed ? " live--armed" : ""}`} ref={stageRef}>
      <iframe
        className="live__iframe"
        src={screen.iframeSrc}
        sandbox="allow-scripts allow-same-origin"
        allow="fullscreen"
        title={screen.item.name}
      />
      <button className="backbtn backbtn--float" onClick={onBack}>
        ‹ {screen.project.name}
      </button>
      <div className="live__caption">
        {screen.item.name}
        {screen.project.artist ? <span className="live__artist"> · {screen.project.artist}</span> : null}
      </div>
      <button
        className="live__fullscreen"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          {isFullscreen ? (
            <path d="M8 3v3H5v2h5V3H8zm6 0v5h5V6h-3V3h-2zM3 14h5v5H6v-3H3v-2zm13 0h5v2h-3v3h-2v-5z" />
          ) : (
            <path d="M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM3 14h2v5h5v2H3v-7zm16 0h2v7h-7v-2h5v-5z" />
          )}
        </svg>
      </button>
    </div>
  );
}
