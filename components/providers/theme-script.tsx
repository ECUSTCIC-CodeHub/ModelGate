import Script from "next/script";

/**
 * Theme bootstrap — runs before hydration so `<html>` gets the right
 * `dark` class synchronously and we avoid a flash of the wrong theme.
 *
 * Uses `next/script` with `beforeInteractive` instead of a raw <script>
 * tag because React 19 warns about inline scripts rendered by React
 * components (they are only executed in the initial SSR HTML).
 */
export function ThemeScript() {
  return (
    <Script id="theme-bootstrap" strategy="beforeInteractive">
      {`
        (function() {
          try {
            var stored = localStorage.getItem('theme');
            var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            var theme = stored || (prefersDark ? 'dark' : 'light');
            if (theme === 'light') {
              document.documentElement.classList.remove('dark');
            } else {
              document.documentElement.classList.add('dark');
            }
          } catch(e) {}
        })();
      `}
    </Script>
  );
}
