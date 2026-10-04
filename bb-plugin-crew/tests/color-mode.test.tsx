// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHostColorMode } from "../components/crew-topology";

function Probe({ bg }: { bg: string }) {
  const [ref, mode] = useHostColorMode();
  return (
    <div ref={ref} style={{ backgroundColor: bg }} data-mode={mode} />
  );
}

describe("useHostColorMode (BBP-81)", () => {
  it("follows a live theme switch on <html>, not only the theme at mount", async () => {
    const view = render(<Probe bg="rgb(255, 255, 255)" />);
    const probe = view.container.firstElementChild as HTMLElement;
    expect(probe.dataset.mode).toBe("light");
    // BB switches the theme by class on <html>; the tokens behind bg-background change with it.
    probe.style.backgroundColor = "rgb(0, 0, 0)";
    await act(async () => {
      document.documentElement.classList.add("dark");
      await Promise.resolve();
    });
    expect(probe.dataset.mode).toBe("dark");
    document.documentElement.classList.remove("dark");
    view.unmount();
  });

  it("negative: without a theme switch the mode stays as measured", async () => {
    const view = render(<Probe bg="rgb(255, 255, 255)" />);
    const probe = view.container.firstElementChild as HTMLElement;
    probe.style.backgroundColor = "rgb(0, 0, 0)";
    await act(async () => {
      await Promise.resolve();
    });
    expect(probe.dataset.mode).toBe("light");
    view.unmount();
  });
});
