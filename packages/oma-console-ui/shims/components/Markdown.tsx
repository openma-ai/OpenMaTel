/**
 * Markdown shim.
 *
 * The upstream console's `components/Markdown.tsx` is built on
 * `react-markdown` + `lowlight` + a hand-picked highlight.js language set.
 * That dependency stack is not part of OpenMaTel's app, so this shim keeps
 * the same public surface (`<Markdown>{text}</Markdown>`) and renders through
 * the published `@openma/common/chat-ui` markdown renderer instead.
 *
 * Controlled by OpenMaTel, not vendored OpenMA code.
 */

import { ChatMarkdown } from "@openma/common/chat-ui";

export function Markdown({ children }: { children: string }) {
  return <ChatMarkdown text={children} />;
}
