import Script from "next/script";
import { generateThemeCssVariables, cssVariablesToText } from "@/lib/shared/color";

export function ThemeScript({ themeColor }: { themeColor: string | null }) {
  let colorScript = "";
  if (themeColor) {
    const vars = generateThemeCssVariables(themeColor);
    const lightCss = cssVariablesToText(vars.light);
    const darkCss = cssVariablesToText(vars.dark);
    colorScript = `(function() {
      try {
        var style = document.createElement('style');
        style.id = 'modelgate-theme';
        style.textContent = ':root{${lightCss}}' + '.dark{${darkCss}}';
        document.head.appendChild(style);
      } catch(e) {}
    })();`;
  }

  return (
    <Script id="theme-bootstrap" strategy="beforeInteractive">{`
      (function() {
        try {
          var root = document.documentElement;
          var appearance = root.dataset.appearance || 'default';
          var mode = root.dataset.mode || 'light';
          var actualMode = mode;
          if (mode === 'system') {
            actualMode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
          }
          root.classList.toggle('dark', actualMode === 'dark');
          root.classList.toggle('retro', appearance === 'retro');
          try {
            localStorage.setItem('modelgate-appearance', appearance);
            localStorage.setItem('modelgate-mode', mode);
          } catch (e) {
            console.warn('Failed to sync theme to localStorage:', e);
          }
        } catch(e) {}
      })();
      ${colorScript}
    `}</Script>
  );
}
