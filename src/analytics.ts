/**
 * Thin GA4 wrapper, mirrored from the paraplot project. The measurement ID
 * comes from the build environment (VITE_GA_MEASUREMENT_ID); without it every
 * call is a no-op and no gtag script is loaded.
 *
 * Nothing that identifies the user's images is sent: no file names, no image
 * pixels, no transforms and no sample data. Events carry only coarse flags and
 * counts (strategy, degrees of freedom, candidate count, ...).
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const measurementId = (import.meta.env.VITE_GA_MEASUREMENT_ID ?? '').trim();
let enabled = false;

export function initAnalytics(): void {
  if (!measurementId || enabled || typeof window === 'undefined') return;
  enabled = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // the standard gtag queue accepts array-like argument objects
    window.dataLayer!.push(arguments);
  };

  window.gtag('js', new Date());
  window.gtag('config', measurementId, { send_page_view: false });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
}

export function track(event: string, params: Record<string, unknown> = {}): void {
  if (!enabled || typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  window.gtag('event', event, params);
}

export type Surface = 'landing' | 'studio' | 'guide';

const SURFACE_META: Record<Surface, { hash: string; title: string }> = {
  landing: { hash: '', title: 'mi-align — affine image alignment' },
  studio: { hash: '#studio', title: 'mi-align — alignment studio' },
  guide: { hash: '#guide', title: 'mi-align — field guide' },
};

/** Keep page paths stable and free of session-specific state. */
export function trackPageView(surface: Surface): void {
  if (!enabled || typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  const base = import.meta.env.BASE_URL || '/';
  const meta = SURFACE_META[surface];
  window.gtag('event', 'page_view', {
    page_location: `${window.location.origin}${base}${meta.hash}`,
    page_path: `${base}${meta.hash}`,
    page_title: meta.title,
    surface,
  });
}
