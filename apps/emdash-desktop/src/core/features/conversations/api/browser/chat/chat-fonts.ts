/**
 * The chat's sans-serif fonts, as `--chat-font-sans` in renderer/index.css sets them. The chat
 * lays text out by measuring it in these fonts and places each run where measuring puts it, so
 * measuring in another font leaves gaps or overlaps between runs (before inline code, links,
 * mentions).
 */
export const CHAT_SANS_FONTS = [
  '-apple-system',
  'BlinkMacSystemFont',
  'Segoe UI',
  'Roboto',
  'Oxygen',
  'Ubuntu',
  'Cantarell',
  'Fira Sans',
  'Droid Sans',
  'Helvetica Neue',
  'sans-serif',
] as const;
