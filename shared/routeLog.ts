import { ROUTE_PREVIEW_LIMIT, type RouteLogInput } from './ipc';

export const MAX_ROUTE_TARGETS = 64;
export const MAX_ROUTE_LABEL = 256;

/** Validates and normalises renderer-supplied log input. Returns null when rejected. */
export function parseRouteInput(raw: unknown): RouteLogInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'composer' && o.kind !== 'forward') return null;
  if (typeof o.fromLabel !== 'string' || o.fromLabel.length === 0) return null;
  if (!Array.isArray(o.targets) || o.targets.length === 0 || o.targets.length > MAX_ROUTE_TARGETS) return null;
  if (!o.targets.every((t) => typeof t === 'string' && t.length > 0 && t.length <= MAX_ROUTE_LABEL)) return null;
  if (typeof o.preview !== 'string') return null;
  const bytes = typeof o.bytes === 'number' && Number.isFinite(o.bytes) && o.bytes >= 0 ? Math.floor(o.bytes) : 0;
  return {
    kind: o.kind,
    fromLabel: o.fromLabel.slice(0, MAX_ROUTE_LABEL),
    targets: [...(o.targets as string[])],
    preview: o.preview.slice(0, ROUTE_PREVIEW_LIMIT),
    bytes,
    viaFile: o.viaFile === true,
  };
}
