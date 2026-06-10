import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { trackPageView } from '../api/client';

/**
 * Posts one pageview beacon per route change, plus one for the initial load.
 * Only the pathname is sent — query strings can carry reset-password tokens
 * and must never reach analytics.
 */
export function usePageTracking(): void {
  const { pathname } = useLocation();
  const isFirstLoad = useRef(true);

  useEffect(() => {
    // document.referrer is only meaningful for the landing view; in-app
    // navigations get no referrer.
    const referrer = isFirstLoad.current && document.referrer ? document.referrer : undefined;
    isFirstLoad.current = false;
    trackPageView(pathname, referrer);
  }, [pathname]);
}
