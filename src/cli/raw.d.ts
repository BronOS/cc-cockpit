// Vite's `?raw` import of the guide topics (see guide.ts), of the `ccc plugin new` template
// files (plugin-new.ts) and of the component stylesheet (src/sdk/panel.ts): the file's text as a
// string. Also in tsconfig.web.json, which type-checks panel.ts for the browser.
declare module '*.md?raw' {
  const text: string
  export default text
}
declare module '*.ts?raw' {
  const text: string
  export default text
}
declare module '*.tmpl?raw' {
  const text: string
  export default text
}
declare module '*.css?raw' {
  const text: string
  export default text
}
