// Server component: must NOT be "use client".
// React 19 does not execute <script dangerouslySetInnerHTML> when rendered on
// the client, so the theme bootstrap script has to be emitted during SSR.
export function ThemeScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `
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
        `,
      }}
    />
  );
}
