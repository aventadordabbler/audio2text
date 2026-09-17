import path from "node:path";
import postcss from "postcss";
import tailwind from "tailwindcss-v3";
import animate from "tailwindcss-animate";
import { converter, formatRgb, parse } from "culori";

const rgb = converter("rgb");

// Translate the utility spellings used by our shared shadcn components. Apply the
// same translation to Tailwind's content scan and the renderer's source code.
function legacyUtilities(source) {
  return source
    .replace(/-\((--[\w-]+)\)/g, "-[var($1)]")
    .replace(/--spacing\((\d+)\)/g, (_, value) => `${Number(value) * 0.25}rem`)
    .replace(/has-data-\[([^\]]+)\]/g, "has-[[data-$1]]")
    .replace(/in-data-\[([^\]]+)\]/g, "[[data-$1]_&]")
    .replace(/not-data-\[([^\]]+)\]/g, "[&:not([data-$1])]")
    .replace(/not-aria-\[([^\]]+)\]/g, "[&:not([aria-$1])]")
    .replace(/\*:\[([^\]]+)\]:/g, "[&>$1]:")
    .replace(/\*\*:/g, "[&_*]:")
    .replace(/bg-\[color-mix\(in_oklch,var\(--secondary\),var\(--foreground\)_5%\)\]/g, "bg-[#e8e8e8]");
}

export function win7Renderer() {
  // Vite IDs and content globs use forward slashes, including on Windows hosts.
  const sourceDirectory = path.resolve(import.meta.dirname, "../src").replaceAll("\\", "/");
  return {
    name: "win7-renderer",
    enforce: "pre",
    async transform(source, id) {
      const file = id.split("?")[0].replaceAll("\\", "/");
      if (!file.startsWith(`${sourceDirectory}/`)) return;
      if (/\.[jt]sx?$/.test(file)) {
        const prefix = /\/(?:main|minutes-main)\.jsx$/.test(file)
          ? 'import "./compat/win7.js";\n'
          : "";
        return { code: prefix + legacyUtilities(source), map: null };
      }
      if (file !== `${sourceDirectory}/index.css`) return;

      const css = postcss.parse(source, { from: file });
      const colors = {};
      css.walkAtRules("import", (rule) => {
        if (rule.params === '"tailwindcss"') {
          rule.replaceWith(...["base", "components", "utilities"].map((params) =>
            postcss.atRule({ name: "tailwind", params })));
        } else if (/"(?:tw-animate-css|shadcn\/tailwind.css)"/.test(rule.params)) {
          rule.remove();
        }
      });
      const imports = [];
      css.walkAtRules("import", (rule) => { imports.push(rule); rule.remove(); });
      css.walkAtRules("custom-variant", (rule) => rule.remove());
      css.walkAtRules("theme", (rule) => {
        rule.walkDecls(/^--color-/, (decl) => {
          const name = decl.prop.slice("--color-".length);
          colors[name] = `rgb(var(--win7-${name}) / calc(var(--win7-${name}-alpha, 1) * <alpha-value>))`;
        });
        rule.replaceWith(postcss.rule({ selector: ":root", nodes: rule.nodes }));
      });
      // Preserve the shared light/dark palette and opacity utilities without
      // OKLCH, relative colors or color-mix(), which need a newer Chromium.
      css.walkDecls(/^--/, (decl) => {
        if (decl.prop.startsWith("--win7-")) return;
        const color = parse(decl.value);
        if (!color) return;
        const value = rgb(color);
        decl.value = formatRgb(value);
        decl.cloneAfter({
          prop: `--win7-${decl.prop.slice(2)}`,
          value: [value.r, value.g, value.b].map((channel) =>
            Math.round(Math.max(0, Math.min(1, channel)) * 255)).join(" "),
        });
        decl.cloneAfter({ prop: `--win7-${decl.prop.slice(2)}-alpha`, value: String(value.alpha ?? 1) });
      });
      // Keep workspace styles outside the utility layer, as in the v4 build.
      // Otherwise v3's attribute variants can override custom component sizing.
      const customRules = css.nodes.filter((node) => node.type === "rule" ||
        (node.type === "atrule" && !["tailwind", "layer"].includes(node.name)));
      for (const rule of customRules) rule.raws.win7Unlayered = true;
      const result = await postcss([tailwind({
        content: {
          files: [`${sourceDirectory}/**/*.{js,jsx,ts,tsx}`],
          transform: { DEFAULT: legacyUtilities },
        },
        darkMode: "class",
        theme: {
          extend: {
            colors,
            fontFamily: { sans: ["var(--font-sans)"], heading: ["var(--font-sans)"] },
            borderRadius: Object.fromEntries(["sm", "md", "lg", "xl", "2xl", "3xl", "4xl"].map((size) =>
              [size, `var(--radius-${size})`])),
            ringWidth: { 3: "3px" },
            blur: { xs: "4px" },
            minWidth: ({ theme }) => theme("spacing"),
            data: {
              open: 'state="open"', closed: 'state="closed"',
              checked: 'state="checked"', unchecked: 'state="unchecked"',
              active: 'state="active"', disabled: "disabled", placeholder: "placeholder",
              horizontal: 'orientation="horizontal"', vertical: 'orientation="vertical"',
            },
          },
        },
        plugins: [animate, ({ addUtilities, addVariant }) => {
          addUtilities({ ".outline-hidden": { outline: "2px solid transparent", outlineOffset: "2px" } });
          addVariant("supports-backdrop-filter", "@supports (backdrop-filter: blur(1px))");
        }],
      })]).process(css, { from: file, map: false });
      // Tailwind may clone rules when expanding @apply. Move the processed
      // rules, carrying their PostCSS metadata, rather than the original nodes.
      const processedCustomRules = result.root.nodes.filter((node) => node.raws.win7Unlayered);
      for (const rule of processedCustomRules) {
        delete rule.raws.win7Unlayered;
        rule.remove();
      }
      const output = postcss.root({ nodes: [
        ...imports,
        postcss.atRule({ name: "layer", params: "win7-utilities", nodes: result.root.nodes }),
        ...processedCustomRules,
      ] });
      return { code: output.toString(), map: null };
    },
  };
}
