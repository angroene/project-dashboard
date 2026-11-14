import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import MarkdownBody from "./MarkdownBody";

describe("MarkdownBody", () => {
  it("renders headings, emphasis and lists", () => {
    render(<MarkdownBody text={"# Title\n\nSome **bold** text\n\n- one\n- two"} />);
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("opens external links in a new tab without opener access", () => {
    render(<MarkdownBody text="[docs](https://example.org/x)" />);
    const a = screen.getByRole("link", { name: "docs" });
    expect(a).toHaveAttribute("href", "https://example.org/x");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("keeps in-page anchors in the same tab", () => {
    render(<MarkdownBody text="[top](#top)" />);
    const a = screen.getByRole("link", { name: "top" });
    expect(a).toHaveAttribute("href", "#top");
    expect(a).not.toHaveAttribute("target");
  });

  it("neutralises javascript: URLs", () => {
    render(<MarkdownBody text="[x](javascript:alert(1))" />);
    const a = screen.getByText("x");
    expect(a.getAttribute("href") ?? "").toBe("");
  });

  it("shows same-origin images but replaces remote ones with a placeholder", () => {
    render(<MarkdownBody text={"![local pic](/api/img.png)\n\n![remote pic](https://example.org/p.png)\n\n![](//cdn.example.org/q.png)"} />);
    expect(screen.getByRole("img", { name: "local pic" })).toHaveAttribute("src", "/api/img.png");
    expect(screen.getByText("[image: remote pic]")).toBeInTheDocument();
    expect(screen.getByText("[image]")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "remote pic" })).not.toBeInTheDocument();
  });

  it("drops raw HTML", () => {
    const { container } = render(<MarkdownBody text="before <script>window.x=1</script><b>raw</b> after" />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });
});
