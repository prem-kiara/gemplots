'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { useToast } from './Toast';
import { ChevronLeft, CheckIcon } from './icons';
import { api, ApiError } from '@/lib/api';
import { S } from '@/lib/strings';
import type { AdminPlotRow, AdminSiteMap } from '@/lib/types';

type Geom = { polygon: number[][]; centroid: number[] };
type Mode = 'draw' | 'edit';

const SCALE_MIN = 1;
const SCALE_MAX = 6;
const CLOSE_PX = 12; // click within this many screen px of the first vertex closes the polygon

function centroidOf(poly: number[][]): number[] {
  const n = poly.length || 1;
  const sx = poly.reduce((a, [x]) => a + x, 0);
  const sy = poly.reduce((a, [, y]) => a + y, 0);
  return [sx / n, sy / n];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function PolygonEditor({
  projectId,
  siteMap,
  plots,
  onBack,
}: {
  projectId: string;
  siteMap: AdminSiteMap;
  plots: AdminPlotRow[];
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  // Geometry state keyed by plot_id, hydrated from the server payload.
  const [geoms, setGeoms] = useState<Record<string, Geom>>(() => {
    const init: Record<string, Geom> = {};
    for (const g of siteMap.geometries) init[g.plot_id] = { polygon: g.polygon, centroid: g.centroid };
    return init;
  });
  const historyRef = useRef<Record<string, Geom>[]>([]);
  const [mode, setMode] = useState<Mode>('draw');
  const [selectedPlotId, setSelectedPlotId] = useState<string | null>(null);
  const [draft, setDraft] = useState<number[][]>([]); // in-progress polygon (normalized)
  const [cursor, setCursor] = useState<number[] | null>(null); // rubber-band target (normalized)
  const [pendingPolygon, setPendingPolygon] = useState<number[][] | null>(null); // awaiting plot assign
  const [missing, setMissing] = useState<Set<string>>(new Set()); // MAP_INCOMPLETE highlights
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [confirmActivate, setConfirmActivate] = useState(false);

  // Snapshot the current geoms before a mutation so Ctrl+Z can restore it.
  const pushHistory = useCallback(() => {
    historyRef.current.push(structuredClone(geoms));
    if (historyRef.current.length > 50) historyRef.current.shift();
  }, [geoms]);

  // ---- pan/zoom transform layer (reuses PlotMap's aspect-fit approach) --------------------
  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [layer, setLayer] = useState<{ w: number; h: number } | null>(null);
  const { width_px: width, height_px: height } = siteMap;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!cw || !ch || !width || !height) return;
      const s = Math.min(cw / width, ch / height);
      setLayer({ w: Math.round(width * s), h: Math.round(height * s) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  const clampTranslate = useCallback(
    (scale: number, x: number, y: number) => {
      const w = layer?.w ?? containerRef.current?.clientWidth ?? 0;
      const h = layer?.h ?? containerRef.current?.clientHeight ?? 0;
      const maxX = ((scale - 1) * w) / 2;
      const maxY = ((scale - 1) * h) / 2;
      return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
    },
    [layer],
  );

  function applyZoom(nextScale: number, clientX: number, clientY: number) {
    setTransform((t) => {
      const el = containerRef.current;
      if (!el) return t;
      const rect = el.getBoundingClientRect();
      const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, nextScale));
      const cx = clientX - rect.left - rect.width / 2;
      const cy = clientY - rect.top - rect.height / 2;
      const ratio = scale / t.scale;
      const nx = cx - (cx - t.x) * ratio;
      const ny = cy - (cy - t.y) * ratio;
      return { scale, ...clampTranslate(scale, nx, ny) };
    });
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    applyZoom(transform.scale * factor, e.clientX, e.clientY);
  }

  // Space-drag pan (avoids clashing with draw/edit clicks).
  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  // ---- coordinate mapping ------------------------------------------------------------------
  // The SVG overlay shares the layer's exact on-screen rect (viewBox 0..1, preserveAspectRatio
  // none). Reading the live rect makes this correct under any pan/zoom.
  const toNorm = useCallback((clientX: number, clientY: number): number[] => {
    const el = layerRef.current;
    if (!el) return [0, 0];
    const r = el.getBoundingClientRect();
    return [clamp01((clientX - r.left) / r.width), clamp01((clientY - r.top) / r.height)];
  }, []);

  // Distance in screen px between a normalized point and a client point.
  const pxDist = useCallback((norm: number[], clientX: number, clientY: number): number => {
    const el = layerRef.current;
    if (!el) return Infinity;
    const r = el.getBoundingClientRect();
    const px = r.left + norm[0] * r.width;
    const py = r.top + norm[1] * r.height;
    return Math.hypot(px - clientX, py - clientY);
  }, []);

  // ---- assignment bookkeeping --------------------------------------------------------------
  const assignedIds = useMemo(() => new Set(Object.keys(geoms)), [geoms]);
  const unassignedPlots = useMemo(
    () => plots.filter((p) => !assignedIds.has(p.id)),
    [plots, assignedIds],
  );

  // ---- draw mode ---------------------------------------------------------------------------
  function closeDraft(poly: number[][]) {
    if (poly.length < 3) {
      toast.error(S.admin.editor.needClose);
      return;
    }
    setPendingPolygon(poly);
    setDraft([]);
    setCursor(null);
  }

  function onLayerClick(e: React.MouseEvent) {
    if (spaceDown || panRef.current) return;
    if (mode !== 'draw') return;
    const p = toNorm(e.clientX, e.clientY);
    // Click near the first vertex closes the polygon.
    if (draft.length >= 3 && pxDist(draft[0], e.clientX, e.clientY) <= CLOSE_PX) {
      closeDraft(draft);
      return;
    }
    setDraft((d) => [...d, p]);
  }

  function onLayerMove(e: React.MouseEvent) {
    if (panRef.current) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setTransform((t) => ({
        ...t,
        ...clampTranslate(t.scale, panRef.current!.origX + dx, panRef.current!.origY + dy),
      }));
      return;
    }
    if (mode === 'draw' && draft.length > 0) setCursor(toNorm(e.clientX, e.clientY));
  }

  function assignPlot(plotId: string) {
    if (!pendingPolygon) return;
    pushHistory();
    setGeoms((g) => ({
      ...g,
      [plotId]: { polygon: pendingPolygon, centroid: centroidOf(pendingPolygon) },
    }));
    setMissing((m) => {
      const next = new Set(m);
      next.delete(plotId);
      return next;
    });
    setPendingPolygon(null);
  }

  // ---- edit mode: drag a vertex ------------------------------------------------------------
  const dragRef = useRef<{ plotId: string; index: number } | null>(null);

  function onVertexDown(e: React.PointerEvent, plotId: string, index: number) {
    if (mode !== 'edit') return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pushHistory();
    setSelectedPlotId(plotId);
    dragRef.current = { plotId, index };
  }

  function onVertexMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const p = toNorm(e.clientX, e.clientY);
    setGeoms((g) => {
      const geom = g[d.plotId];
      if (!geom) return g;
      const poly = geom.polygon.map((pt, i) => (i === d.index ? p : pt));
      return { ...g, [d.plotId]: { polygon: poly, centroid: centroidOf(poly) } };
    });
  }

  function onVertexUp(e: React.PointerEvent) {
    if (dragRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }

  function deleteSelected() {
    if (!selectedPlotId) return;
    pushHistory();
    setGeoms((g) => {
      const next = { ...g };
      delete next[selectedPlotId];
      return next;
    });
    setSelectedPlotId(null);
  }

  function undo() {
    const prev = historyRef.current.pop();
    if (prev) {
      setGeoms(prev);
      setSelectedPlotId(null);
    }
  }

  // ---- keyboard: Enter closes draft, Escape cancels, Ctrl+Z undo ---------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === ' ' && !e.repeat) setSpaceDown(true);
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
      } else if (e.key === 'Enter' && mode === 'draw' && draft.length >= 3) {
        e.preventDefault();
        closeDraft(draft);
      } else if (e.key === 'Escape') {
        if (pendingPolygon) setPendingPolygon(null);
        else if (draft.length) {
          setDraft([]);
          setCursor(null);
        } else setSelectedPlotId(null);
      }
    }
    function onUp(e: KeyboardEvent) {
      if (e.key === ' ') setSpaceDown(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, draft, pendingPolygon]);

  // ---- save / activate ---------------------------------------------------------------------
  async function save() {
    setSaving(true);
    try {
      const geometries = Object.entries(geoms).map(([plot_id, g]) => ({
        plot_id,
        polygon: g.polygon,
        centroid: g.centroid,
      }));
      await api(`/v1/admin/site-maps/${siteMap.id}/geometries`, {
        method: 'POST',
        body: { geometries },
      });
      toast.success(S.admin.editor.saved);
      qc.invalidateQueries({ queryKey: ['admin', 'project', projectId] });
      qc.invalidateQueries({ queryKey: ['map', projectId] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : S.admin.editor.saveError);
    } finally {
      setSaving(false);
    }
  }

  async function activate() {
    setActivating(true);
    try {
      // Persist the current set first so activation checks the drawn geometries.
      const geometries = Object.entries(geoms).map(([plot_id, g]) => ({
        plot_id,
        polygon: g.polygon,
        centroid: g.centroid,
      }));
      await api(`/v1/admin/site-maps/${siteMap.id}/geometries`, {
        method: 'POST',
        body: { geometries },
      });
      const res = await api<{ version: number }>(`/v1/admin/site-maps/${siteMap.id}/activate`, {
        method: 'POST',
      });
      toast.success(S.admin.editor.activated(res.version));
      qc.invalidateQueries({ queryKey: ['admin', 'project', projectId] });
      qc.invalidateQueries({ queryKey: ['map', projectId] });
      setConfirmActivate(false);
      onBack();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MAP_INCOMPLETE') {
        const ids = (err.details?.missing_plot_ids as string[]) ?? [];
        setMissing(new Set(ids));
        toast.error(S.admin.editor.incomplete);
      } else {
        toast.error(err instanceof ApiError ? err.message : S.admin.editor.saveError);
      }
      setConfirmActivate(false);
    } finally {
      setActivating(false);
    }
  }

  // Plot metadata for labels/pickers.
  const plotById = useMemo(() => {
    const m = new Map<string, AdminPlotRow>();
    for (const p of plots) m.set(p.id, p);
    return m;
  }, [plots]);

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[520px] flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-gp-sm font-semibold text-muted hover:text-ink"
        >
          <ChevronLeft width={16} height={16} />
          {S.admin.editor.back}
        </button>
        <h1 className="ml-2 text-gp-lg font-semibold text-ink">{S.admin.editor.title(siteMap.version)}</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-control border border-line">
            <button
              onClick={() => {
                setMode('draw');
                setSelectedPlotId(null);
              }}
              className={`px-3 py-2 text-gp-sm font-semibold ${
                mode === 'draw' ? 'bg-primary text-white' : 'bg-white text-ink hover:bg-bg'
              }`}
            >
              {S.admin.editor.draw}
            </button>
            <button
              onClick={() => {
                setMode('edit');
                setDraft([]);
                setCursor(null);
              }}
              className={`px-3 py-2 text-gp-sm font-semibold ${
                mode === 'edit' ? 'bg-primary text-white' : 'bg-white text-ink hover:bg-bg'
              }`}
            >
              {S.admin.editor.edit}
            </button>
          </div>
          <Button variant="secondary" onClick={undo} disabled={historyRef.current.length === 0}>
            {S.admin.editor.undo}
          </Button>
          {mode === 'edit' && (
            <Button variant="danger" onClick={deleteSelected} disabled={!selectedPlotId}>
              {S.admin.editor.deleteSelected}
            </Button>
          )}
          <Button variant="secondary" onClick={save} loading={saving}>
            {S.admin.editor.save}
          </Button>
          <Button onClick={() => setConfirmActivate(true)} loading={activating}>
            {S.admin.editor.activate}
          </Button>
        </div>
      </div>

      <p className="text-gp-sm text-muted">
        {mode === 'draw' ? S.admin.editor.hintDraw : S.admin.editor.hintEdit}
      </p>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Map canvas */}
        <div
          ref={containerRef}
          className="relative flex min-w-0 flex-1 touch-none select-none items-center justify-center overflow-hidden rounded-card border border-line bg-line"
          onWheel={onWheel}
          onPointerDown={(e) => {
            if (spaceDown) {
              panRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                origX: transform.x,
                origY: transform.y,
              };
            }
          }}
          onPointerUp={() => {
            panRef.current = null;
          }}
          onMouseMove={onLayerMove}
        >
          <div
            ref={layerRef}
            className="relative origin-center"
            style={{
              width: layer ? `${layer.w}px` : '100%',
              height: layer ? `${layer.h}px` : '100%',
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              cursor: spaceDown ? 'grab' : mode === 'draw' ? 'crosshair' : 'default',
            }}
            onClick={onLayerClick}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={siteMap.image_url}
              alt="Site plan"
              width={width}
              height={height}
              draggable={false}
              className="pointer-events-none h-full w-full"
            />
            <svg
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full"
              onPointerMove={onVertexMove}
              onPointerUp={onVertexUp}
            >
              {/* Saved polygons */}
              {Object.entries(geoms).map(([plotId, g]) => {
                const selected = plotId === selectedPlotId;
                const isMissing = missing.has(plotId);
                const points = g.polygon.map(([x, y]) => `${x},${y}`).join(' ');
                const plot = plotById.get(plotId);
                return (
                  <g key={plotId}>
                    <polygon
                      points={points}
                      fill={isMissing ? '#dc2626' : '#047857'}
                      fillOpacity={selected ? 0.4 : 0.25}
                      stroke={selected ? '#111827' : isMissing ? '#dc2626' : '#047857'}
                      strokeWidth={selected ? 3 : 1.5}
                      vectorEffect="non-scaling-stroke"
                      role="button"
                      tabIndex={0}
                      aria-label={`Plot ${plot?.plot_number ?? plotId}, assigned`}
                      style={{ cursor: mode === 'edit' ? 'pointer' : 'default' }}
                      onClick={(e) => {
                        if (mode === 'edit') {
                          e.stopPropagation();
                          setSelectedPlotId(plotId);
                        }
                      }}
                    />
                    {mode === 'edit' && selected &&
                      g.polygon.map(([x, y], i) => (
                        <circle
                          key={i}
                          cx={x}
                          cy={y}
                          r={0.007}
                          fill="#ffffff"
                          stroke="#111827"
                          strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke"
                          style={{ cursor: 'move' }}
                          aria-label={`Vertex ${i + 1} of plot ${plot?.plot_number ?? plotId}`}
                          onPointerDown={(e) => onVertexDown(e, plotId, i)}
                        />
                      ))}
                    {g.centroid && (
                      <text
                        x={g.centroid[0]}
                        y={g.centroid[1]}
                        fontSize={0.014}
                        fontWeight={700}
                        fill="#111827"
                        textAnchor="middle"
                        dominantBaseline="central"
                        pointerEvents="none"
                        stroke="#ffffff"
                        strokeWidth={0.003}
                        style={{ paintOrder: 'stroke' }}
                      >
                        {plot?.plot_number ?? ''}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* In-progress draft polygon */}
              {draft.length > 0 && (
                <g>
                  <polyline
                    points={[...draft, ...(cursor ? [cursor] : [])].map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none"
                    stroke="#d97706"
                    strokeWidth={2}
                    strokeDasharray="0.01 0.006"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                  {draft.map(([x, y], i) => (
                    <circle
                      key={i}
                      cx={x}
                      cy={y}
                      r={0.008}
                      fill={i === 0 ? '#d97706' : '#ffffff'}
                      stroke="#d97706"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  ))}
                </g>
              )}
            </svg>
          </div>
        </div>

        {/* Right panel: plots */}
        <div className="w-64 shrink-0 overflow-y-auto rounded-card border border-line bg-white p-3">
          <h2 className="mb-2 text-gp-base font-semibold text-ink">{S.admin.editor.plots}</h2>
          <ul className="space-y-1">
            {plots.map((p) => {
              const assigned = assignedIds.has(p.id);
              const isMissing = missing.has(p.id);
              return (
                <li
                  key={p.id}
                  className={`flex items-center justify-between rounded-control px-2.5 py-1.5 text-gp-sm ${
                    isMissing
                      ? 'bg-danger/10 text-danger'
                      : selectedPlotId === p.id
                        ? 'bg-primary/10'
                        : 'hover:bg-bg'
                  } ${assigned && mode === 'edit' ? 'cursor-pointer' : ''}`}
                  onClick={() => assigned && mode === 'edit' && setSelectedPlotId(p.id)}
                >
                  <span className="font-medium text-ink">{p.plot_number}</span>
                  {assigned ? (
                    <span className="inline-flex items-center gap-1 text-primary">
                      <CheckIcon width={13} height={13} />
                      {S.admin.editor.assigned}
                    </span>
                  ) : (
                    <span className="text-muted">{S.admin.editor.unassigned}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Plot picker for a freshly-drawn polygon */}
      {pendingPolygon && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={S.admin.editor.assignPrompt}
        >
          <div className="absolute inset-0 bg-ink/40" onClick={() => setPendingPolygon(null)} aria-hidden="true" />
          <div className="relative z-10 w-full max-w-sm rounded-card bg-white p-5 shadow-modal">
            <h2 className="mb-3 text-gp-lg font-semibold text-ink">{S.admin.editor.assignPrompt}</h2>
            {unassignedPlots.length === 0 ? (
              <EmptyState title="All plots are assigned" />
            ) : (
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {unassignedPlots.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => assignPlot(p.id)}
                      className="flex w-full items-center justify-between rounded-control px-3 py-2 text-left text-gp-base text-ink hover:bg-bg"
                    >
                      <span className="font-medium">{p.plot_number}</span>
                      <span className="text-gp-sm text-muted">{p.facing || ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" onClick={() => setPendingPolygon(null)}>
                {S.admin.editor.cancel}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmActivate}
        title={S.admin.editor.activateConfirm(siteMap.version)}
        confirmLabel={S.admin.editor.activate}
        loading={activating}
        onConfirm={activate}
        onCancel={() => setConfirmActivate(false)}
      >
        {S.admin.editor.activateBody}
      </ConfirmDialog>
    </div>
  );
}
