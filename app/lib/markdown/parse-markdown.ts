import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { normalizeMarkdown } from "./normalize";

export const MARKDOWN_PARSER_VERSION = "remark-ast-1";

export function parseMarkdown(source: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(normalizeMarkdown(source));
}
