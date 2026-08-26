import { usePageTracking } from '../hooks/usePageTracking';

// exists so the tracking hook runs inside the router context App wraps around it.
export function PageViewTracker(): null {
  usePageTracking();
  return null;
}
