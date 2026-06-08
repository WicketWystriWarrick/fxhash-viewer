import { useEffect, useState } from "react";
import { ClassicApp } from "./ui/classic/ClassicApp";
import { GalleryApp } from "./ui/gallery/GalleryApp";

/**
 * Top-level shell. Picks between two UIs and remembers the choice:
 *   - classic : the sidebar form (URI / File modes) + inline viewer
 *   - gallery : full-screen collection → tiles → live view
 *
 * Selection precedence: URL (?ui=v2 / ?ui=v1) → localStorage → default.
 * A small always-visible switch lets you flip between them.
 */
type UI = "classic" | "gallery";
const STORAGE_KEY = "viewer:ui";

function readStored(): UI | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "gallery" || v === "classic" ? v : null;
  } catch {
    return null;
  }
}

function initialUI(): UI {
  const url = new URLSearchParams(location.search).get("ui");
  if (url === "v2" || url === "gallery") return "gallery";
  if (url === "v1" || url === "classic") return "classic";
  return readStored() ?? "gallery";
}

export function App() {
  const [ui, setUI] = useState<UI>(initialUI);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, ui);
    } catch {
      // Private mode etc. — selection just won't persist.
    }
    const u = new URL(location.href);
    u.searchParams.set("ui", ui === "gallery" ? "v2" : "v1");
    history.replaceState(null, "", u);
  }, [ui]);

  return (
    <>
      <div className="ui-switch" role="group" aria-label="UI version">
        <button
          className={`ui-switch__btn ${ui === "classic" ? "ui-switch__btn--active" : ""}`}
          onClick={() => setUI("classic")}
        >
          Classic
        </button>
        <button
          className={`ui-switch__btn ${ui === "gallery" ? "ui-switch__btn--active" : ""}`}
          onClick={() => setUI("gallery")}
        >
          Gallery
        </button>
      </div>
      {ui === "gallery" ? <GalleryApp /> : <ClassicApp />}
    </>
  );
}
