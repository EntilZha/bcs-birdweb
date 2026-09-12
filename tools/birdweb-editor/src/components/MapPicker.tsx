import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Drop and confirm a birding site's pin.
 *
 * The geocoder proposes candidates but never confirms them -- a wrong pin sends someone
 * driving to the wrong place -- so this is where the 69 sites actually get their
 * coordinates. It has to make two things fast: judging whether a proposed pin is right
 * (hence a real map with terrain and roads, not a blank canvas), and fixing it when it is
 * not (hence click-to-move and drag).
 */

interface Props {
  lat: number | null;
  lon: number | null;
  /** Rendered as a label on the marker so the pin is identifiable while panning. */
  name: string;
  confirmed: boolean;
  onChange: (lat: number, lon: number) => void;
}

// Washington, framed to fit. Where a site has no pin yet, this is what you start from.
const WA_CENTER: [number, number] = [47.4, -120.5];
const WA_BOUNDS: L.LatLngBoundsExpression = [
  [45.5, -124.9],
  [49.1, -116.9],
];

export default function MapPicker({ lat, lon, name, confirmed, onChange }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Create the map once. Leaflet owns its DOM node, so it must not be re-created on every
  // render or each keystroke in the sidebar would tear down and rebuild the tiles.
  useEffect(() => {
    if (!holder.current || map.current) return;
    const instance = L.map(holder.current, {
      center: lat != null && lon != null ? [lat, lon] : WA_CENTER,
      zoom: lat != null ? 13 : 6,
      scrollWheelZoom: true,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(instance);
    instance.on("click", (event: L.LeafletMouseEvent) => {
      onChangeRef.current(
        Number(event.latlng.lat.toFixed(5)),
        Number(event.latlng.lng.toFixed(5)),
      );
    });
    map.current = instance;
    // Leaflet measures its container on creation; in a panel that was just revealed the
    // size can still be zero, which leaves a grey box until something forces a redraw.
    setTimeout(() => instance.invalidateSize(), 50);
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the marker in step with whatever the fields say.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    if (lat == null || lon == null) {
      marker.current?.remove();
      marker.current = null;
      instance.fitBounds(WA_BOUNDS);
      return;
    }

    const icon = L.divIcon({
      className: "",
      html:
        `<div style="transform:translate(-50%,-100%);text-align:center">` +
        `<div style="font-size:26px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">` +
        `${confirmed ? "📍" : "📌"}</div>` +
        `<div style="background:${confirmed ? "#0a3c23" : "#b45309"};color:#fff;` +
        `font:600 11px/1.4 system-ui;padding:1px 6px;border-radius:9999px;white-space:nowrap">` +
        `${name.replace(/</g, "&lt;")}</div></div>`,
      iconSize: [0, 0],
    });

    if (!marker.current) {
      marker.current = L.marker([lat, lon], { draggable: true, icon }).addTo(instance);
      marker.current.on("dragend", (event) => {
        const position = (event.target as L.Marker).getLatLng();
        onChangeRef.current(
          Number(position.lat.toFixed(5)),
          Number(position.lng.toFixed(5)),
        );
      });
    } else {
      marker.current.setLatLng([lat, lon]);
      marker.current.setIcon(icon);
    }
  }, [lat, lon, name, confirmed]);

  // Recentre when the editor switches to a different site.
  useEffect(() => {
    if (map.current && lat != null && lon != null) {
      map.current.setView([lat, lon], Math.max(map.current.getZoom(), 12));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  return (
    <div>
      <div
        ref={holder}
        className="h-80 w-full rounded-xl ring-1 ring-black/10 overflow-hidden"
      />
      <p className="mt-1.5 text-xs text-ink-muted">
        Click the map to place the pin, or drag it. Zoom in far enough to see that it is on
        the right lake, headland or trailhead before confirming.
      </p>
    </div>
  );
}
