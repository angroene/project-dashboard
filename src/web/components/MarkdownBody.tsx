import Markdown, { type Components } from "react-markdown";

const isSameOrigin = (url: string) => url.startsWith("/") && !url.startsWith("//");

/** Raw HTML is skipped (no rehype-raw); unsafe URLs are neutralised by react-markdown's default urlTransform. */
const mdComponents: Components = {
  a: ({ href, children }) =>
    href && href.startsWith("#") ? (
      <a href={href}>{children}</a>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  // Remote images would leak the viewer to third parties; only same-origin images are displayed.
  img: ({ src, alt }) =>
    typeof src === "string" && isSameOrigin(src) ? (
      <img src={src} alt={alt ?? ""} loading="lazy" />
    ) : (
      <span className="muted">[image{alt ? `: ${alt}` : ""}]</span>
    ),
};

export default function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown skipHtml components={mdComponents}>
        {text}
      </Markdown>
    </div>
  );
}
