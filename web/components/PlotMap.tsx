'use client';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { MapPlot, PlotStatus } from '@/lib/types';
import { formatINR } from '@/lib/format';
import { S } from '@/lib/strings';

// §3.1 status fills. Dormant BLOCKED/BOOKED map to ON_HOLD/RESERVED respectively.
function fillFor(status: PlotStatus): string {
  switch (status) {
    case 'AVAILABLE':
      return '#16a34a';
    case 'ON_HOLD':
    case 'BLOCKED':
      return '#f59e0b';
    case 'RESERVED':
    case 'BOOKED':
      return '#2563eb';
    case 'SOLD':
      return '#6b7280';
    default:
      return 'transparent'; // WITHDRAWN not rendered
  }
}

const SCALE_MIN = 1;
const SCALE_MAX = 6;

// §7.4 interactive map: img + unit-viewBox SVG overlay, pan/zoom via pointer events + CSS transform.
export function PlotMap({
  imageUrl,
  width,
  height,
  plots,
  selectedId,
  onSelect,
}: {
  imageUrl: string;
  width: number;
  height: number;
  plots: MapPlot[];
  selectedId?: string;
  onSelect: (plot: MapPlot) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });

  // Pointer bookkeeping for pan + pinch.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const dragState = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const pinchState = useRef<{ dist: number; scale: number } | null>(null);

  const clampTranslate = useCallback(
    (scale: number, x: number, y: number) => {
      const el = containerRef.current;
      if (!el) return { x, y };
      const w = el.clientWidth;
      const h = el.clientHeight;
      const maxX = ((scale - 1) * w) / 2;
      const maxY = ((scale - 1) * h) / 2;
      return {
        x: Math.max(-maxX, Math.min(maxX, x)),
        y: Math.max(-maxY, Math.min(maxY, y)),
      };
    },
    [],
  );

  const applyZoom = useCallback(
    (nextScale: number, centerX: number, centerY: number) => {
      setTransform((t) => {
        const el = containerRef.current;
        if (!el) return t;
        const rect = el.getBoundingClientRect();
        const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, nextScale));
        // Zoom toward the pointer: keep the point under the cursor stable.
        const cx = centerX - rect.left - rect.width / 2;
        const cy = centerY - rect.top - rect.height / 2;
        const ratio = scale / t.scale;
        const nx = cx - (cx - t.x) * ratio;
        const ny = cy - (cy - t.y) * ratio;
        const clamped = clampTranslate(scale, nx, ny);
        return { scale, ...clamped };
      });
    },
    [clampTranslate],
  );

  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: transform.x,
        origY: transform.y,
        moved: false,
      };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchState.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: transform.scale,
      };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinchState.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = dist / pinchState.current.dist;
      const centerX = (a.x + b.x) / 2;
      const centerY = (a.y + b.y) / 2;
      applyZoom(pinchState.current.scale * ratio, centerX, centerY);
      return;
    }

    const ds = dragState.current;
    if (ds && pointers.current.size === 1) {
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) ds.moved = true;
      setTransform((t) => {
        const clamped = clampTranslate(t.scale, ds.origX + dx, ds.origY + dy);
        return { ...t, ...clamped };
      });
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchState.current = null;
    if (pointers.current.size === 0) dragState.current = null;
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    applyZoom(transform.scale * factor, e.clientX, e.clientY);
  }

  const lastTap = useRef(0);
  function onDoubleTapArea(e: React.PointerEvent) {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      applyZoom(transform.scale < 3 ? transform.scale * 2 : 1, e.clientX, e.clientY);
    }
    lastTap.current = now;
  }

  function selectIfTap(plot: MapPlot) {
    if (!dragState.current?.moved) onSelect(plot);
  }

  // Font-legibility gate: hide labels when the scaled plot is too small (§7.4).
  const showLabels = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const p of plots) {
      const area = polygonArea(p.polygon);
      map.set(p.plot_id, transform.scale * area * 100 > 0.35);
    }
    return map;
  }, [plots, transform.scale]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full touch-none select-none overflow-hidden rounded-card bg-line"
      onPointerDown={(e) => {
        onPointerDown(e);
        onDoubleTapArea(e);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div
        className="absolute inset-0 origin-center"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt="Site plan"
          width={width}
          height={height}
          draggable={false}
          className="pointer-events-none h-full w-full object-contain"
        />
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          {plots
            .filter((p) => p.status !== 'WITHDRAWN')
            .map((p) => {
              const selected = p.plot_id === selectedId;
              const fill = fillFor(p.status);
              const points = p.polygon.map(([x, y]) => `${x},${y}`).join(' ');
              return (
                <g key={p.plot_id}>
                  <polygon
                    points={points}
                    fill={fill}
                    fillOpacity={selected ? 0.75 : 0.55}
                    stroke={selected ? '#111827' : '#ffffff'}
                    strokeWidth={selected ? 3 : 1.5}
                    vectorEffect="non-scaling-stroke"
                    role="button"
                    tabIndex={0}
                    aria-label={`Plot ${p.plot_number}, ${S.status[p.status] ?? p.status}, ${formatINR(
                      p.price_paise,
                    )}`}
                    style={{ cursor: 'pointer', outline: 'none' }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      selectIfTap(p);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(p);
                      }
                    }}
                  />
                  {showLabels.get(p.plot_id) && p.centroid && (
                    <text
                      x={p.centroid[0]}
                      y={p.centroid[1]}
                      fontSize={0.014}
                      fontWeight={700}
                      fill="#111827"
                      textAnchor="middle"
                      dominantBaseline="central"
                      pointerEvents="none"
                      style={{ paintOrder: 'stroke' }}
                      stroke="#ffffff"
                      strokeWidth={0.003}
                    >
                      {p.plot_number}
                    </text>
                  )}
                </g>
              );
            })}
        </svg>
      </div>
    </div>
  );
}

// Shoelace area on normalized coords (0..1) → fraction of the unit square.
function polygonArea(poly: number[][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
