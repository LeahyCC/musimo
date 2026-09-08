// Vite resolves the pinned renderer as a local asset, loaded only inside its realm.
declare module 'butterchurn/dist/butterchurn.min.js?url' {
  const url: string
  export default url
}
