import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom gaps used by the UI. (Files that opt into the node environment have no DOM.)
const dom = typeof window !== "undefined";
if (dom && !Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (!dom) return;
  cleanup();
  window.location.hash = "";
});
