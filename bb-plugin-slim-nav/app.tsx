// bb-plugin-slim-nav — frontend entry.
//
// Strategy: do not reimplement navigation. `experimental_Original` is BB's own
// navigation component, so saved order, hidden items, routing, shortcuts and
// split gestures keep working. We render it inside a scoped wrapper and shrink
// the rows to icon-only buttons with CSS. Sizes come from settings and are
// pushed down as CSS custom properties.
//
// The CSS targets host DOM attributes (data-testid / data-sidebar-*), so a BB
// UI change can require an update here.
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import type { ExperimentalSidebarNavigationProps } from "@get-bb/plugin-sdk/app";
import type { CSSProperties } from "react";
import { DENSITY_SIZES, type Density } from "./server";
import "./app.css";

const WRAPPER_CLASS = "slim-nav";

/** Settings values are untrusted at this boundary; fall back to the defaults. */
function readDensity(value: unknown): Density {
  return typeof value === "string" && value in DENSITY_SIZES
    ? (value as Density)
    : "compact";
}

function SlimNavigation({
  experimental_Original: Original,
}: ExperimentalSidebarNavigationProps) {
  const { values } = useSettings();
  const size = DENSITY_SIZES[readDensity(values?.density)];
  const hideDivider = values?.hideDivider !== false;

  const style = {
    "--slim-nav-size": `${size}px`,
    "--slim-nav-icon": `${Math.round(size * 0.57)}px`,
  } as CSSProperties;

  return (
    <div
      className={WRAPPER_CLASS}
      data-slim-nav-hide-divider={hideDivider ? "" : undefined}
      style={style}
    >
      <Original />
    </div>
  );
}

export default definePluginApp((app) => {
  // Icon-only buttons lose their visible label, so mirror the host's
  // aria-label into a native tooltip. Only titles we set are removed again.
  app.contentScripts.register({
    id: "slim-nav-tooltips",
    mount() {
      const owned = new Map<HTMLElement, string>();
      const selector = `.${WRAPPER_CLASS} [data-sidebar-navigation-item] > button, .${WRAPPER_CLASS} [data-testid="sidebar-navigation-list"] > button`;

      const sync = () => {
        for (const [button, title] of owned) {
          if (button.isConnected) continue;
          if (button.title === title) button.removeAttribute("title");
          owned.delete(button);
        }
        document.querySelectorAll<HTMLElement>(selector).forEach((button) => {
          if (button.hasAttribute("title")) return;
          const title =
            button.getAttribute("aria-label") ?? button.textContent?.trim();
          if (!title) return;
          button.title = title;
          owned.set(button, title);
        });
      };

      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true });
      sync();

      return () => {
        observer.disconnect();
        for (const [button, title] of owned) {
          if (button.title === title) button.removeAttribute("title");
        }
        owned.clear();
      };
    },
  });

  app.slots.experimental_sidebarNavigation({
    id: "slim",
    title: "Slim Nav",
    description:
      "Icon-only navigation with adjustable density; keeps BB's order, visibility and customization controls.",
    component: SlimNavigation,
  });
});
