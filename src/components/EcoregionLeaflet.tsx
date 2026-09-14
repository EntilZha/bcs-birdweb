import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Washington's ten ecoregions on a real basemap.
 *
 * OpenStreetMap rather than Google: this site will be owned by Birds Connect Seattle for
 * years, and the Google Maps JS API needs a key with billing attached. A key that lapses
 * breaks the map silently and nobody notices until a visitor mentions it. OSM needs
 * neither, and the editor's pin map already runs on it.
 *
 * Not used on /kiosk/, but that is a scope decision rather than a technical one: the
 * storefront screen is a species-lookup tool and a region map is a different task. (An
 * earlier version of this comment claimed the kiosk needed to survive a wifi drop, which
 * is nonsense -- the kiosk loads this site over the network, so if wifi is down there is
 * no page to draw a map on.)
 *
 * The polygons are traced from the legacy site's clickable map, so they are approximate --
 * and on a real basemap that is *more* visible than on a blank outline, because you can
 * see exactly where an edge misses a coastline. They are drawn as soft translucent tint
 * with no hard border so they read as "roughly this area" rather than as a survey.
 */

export interface RegionShape {
  slug: string;
  name: string;
  /** Display number, 0-9, as the original map used. */
  number: number;
  /** [lon, lat] ring. */
  ring: [number, number][];
  /** [lon, lat] to draw the number at — a pole of inaccessibility, not a bounds centre. */
  labelAt: [number, number];
  fill: string;
}

export interface SitePin {
  slug: string;
  name: string;
  lat: number;
  lon: number;
  confirmed: boolean;
}

interface Props {
  regions: RegionShape[];
  sites: SitePin[];
  base: string;
  /** Highlight one region and mute the rest. */
  active?: string;
  height?: string;
}

const WA_BOUNDS: [[number, number], [number, number]] = [
  [45.4, -125.0],
  [49.1, -116.8],
];

export default function EcoregionLeaflet({
  regions,
  sites,
  base,
  active,
  height = "clamp(24rem, 58vh, 40rem)",
}: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!holder.current || map.current) return;

    const instance = L.map(holder.current, {
      scrollWheelZoom: false, // a map inside a scrolling page must not swallow the wheel
      minZoom: 5,
      maxZoom: 12,
      maxBounds: L.latLngBounds(WA_BOUNDS).pad(0.25),
      maxBoundsViscosity: 0.85,
    });
    map.current = instance;
    instance.fitBounds(WA_BOUNDS);

    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    });
    // If the tiles never arrive, say so rather than leaving a grey rectangle.
    let loaded = false;
    tiles.on("load", () => {
      loaded = true;
    });
    tiles.on("tileerror", () => {
      if (!loaded) setFailed(true);
    });
    tiles.addTo(instance);

    // Wheel zoom only once the map has been clicked, so scrolling past it works normally.
    instance.on("click", () => instance.scrollWheelZoom.enable());
    instance.on("mouseout", () => instance.scrollWheelZoom.disable());

    for (const region of regions) {
      const dimmed = active !== undefined && active !== region.slug;
      const polygon = L.polygon(
        region.ring.map(([lon, lat]) => [lat, lon] as [number, number]),
        {
          color: region.fill,
          weight: dimmed ? 1 : 2,
          opacity: dimmed ? 0.35 : 0.75,
          fillColor: region.fill,
          // Soft: these boundaries are approximate, and a crisp edge over real coastline
          // claims a precision they do not have.
          fillOpacity: dimmed ? 0.1 : 0.3,
        },
      ).addTo(instance);

      polygon.bindTooltip(`${region.number} ${region.name}`, { sticky: true });
      polygon.on("mouseover", () => polygon.setStyle({ fillOpacity: 0.48 }));
      polygon.on("mouseout", () => polygon.setStyle({ fillOpacity: dimmed ? 0.1 : 0.3 }));
      polygon.on("click", () => {
        window.location.href = `${base}ecoregions/${region.slug}/`;
      });

      // The number, as the original map did — identity never rests on colour alone.
      // Placed at a precomputed interior point: a bounds centre falls outside any concave
      // shape, and Oceanic's would print its "0" on top of its neighbour's "1".
      L.marker([region.labelAt[1], region.labelAt[0]], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "",
          html:
            `<span style="font:700 20px/1 system-ui;color:#fff;` +
            `-webkit-text-stroke:4px rgba(0,0,0,.4);paint-order:stroke;` +
            `opacity:${dimmed ? 0.4 : 1}">${region.number}</span>`,
          iconSize: [0, 0],
        }),
      }).addTo(instance);
    }

    for (const site of sites) {
      const marker = L.circleMarker([site.lat, site.lon], {
        radius: 6,
        color: "#ffffff",
        weight: 2,
        fillColor: site.confirmed ? "#0a3c23" : "#ffffff",
        fillOpacity: site.confirmed ? 1 : 0.85,
        dashArray: site.confirmed ? undefined : "3 2",
      }).addTo(instance);
      marker.bindTooltip(
        site.confirmed ? site.name : `${site.name} — approximate location`,
      );
      marker.on("click", () => {
        window.location.href = `${base}sites/${site.slug}/`;
      });
    }

    setTimeout(() => instance.invalidateSize(), 60);
    return () => {
      instance.remove();
      map.current = null;
    };
  }, [regions, sites, base, active]);

  return (
    <div>
      <div
        ref={holder}
        style={{ height }}
        className="w-full rounded-2xl ring-1 ring-black/5 overflow-hidden bg-cream"
      />
      {failed && (
        <p className="mt-2 rounded-lg bg-pop/30 px-3 py-2 text-xs text-brand">
          The map tiles could not be loaded. The ecoregions are listed below.
        </p>
      )}
      <p className="mt-2 text-xs text-ink-muted">
        Click a region to open it. Region boundaries are approximate, redrawn from the
        original BirdWeb ecoregion map courtesy of Cindy Lippincott. Click the map before
        scrolling to zoom.
      </p>
    </div>
  );
}
