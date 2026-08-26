import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { trackPageView } from '../api/client';

// only the pathname is sent: query strings can carry reset-password tokens.
export function usePageTracking(): void {
  const { pathname } = useLocation();
  const isFirstLoad = useRef(true);

  useEffect(() => {
    const referrer = isFirstLoad.current && document.referrer ? document.referrer : undefined;
    isFirstLoad.current = false;
    trackPageView(pathname, referrer);
  }, [pathname]);
}
