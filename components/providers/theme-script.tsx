export function ThemeScript() {
  return (
    <script
      id="theme-bootstrap"
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
