import { usePageTracking } from '../hooks/usePageTracking';

// renders nothing — exists so the tracking hook runs inside the router
// context that App itself wraps with BrowserRouter.
export function PageViewTracker(): null {
  usePageTracking();
  return null;
}
