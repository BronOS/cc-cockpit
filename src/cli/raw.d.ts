// Vite's `?raw` import of the guide topics (see guide.ts) and of the `ccc plugin new` template
// files (plugin-new.ts): the file's text as a string.
declare module '*.md?raw' {
  const text: string
  export default text
}
declare module '*.tmpl?raw' {
  const text: string
  export default text
}
