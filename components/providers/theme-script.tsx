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
        style.textContent = ':root{${lightCss}}' + '.dark{${darkCss}}';
        document.documentElement.insertBefore(style, document.documentElement.firstChild);
      } catch(e) {}
    })();`;
  }

  return (
    <Script id="theme-bootstrap" strategy="beforeInteractive">{`
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
      ${colorScript}
    `}</Script>
  );
}
