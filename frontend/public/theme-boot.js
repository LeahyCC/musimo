/* Paints a saved theme before the first frame, so a custom theme does not flash the default one.
   The Content-Security-Policy allows scripts from this origin only, so this cannot be inline, and
   it runs before the module bundle, so it cannot be one either. `src/theme/store.ts` writes the
   key this reads and takes over once the app has loaded.

   Nothing in here is trusted: the property name and the value are both checked against a pattern
   before anything is set, and every failure falls through to the default theme in the stylesheet. */
;(function () {
  try {
    var raw = localStorage.getItem('musimo.theme-vars')
    if (!raw) return
    var saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object') return
    var root = document.documentElement
    var vars = saved.vars
    if (vars && typeof vars === 'object') {
      for (var name in vars) {
        if (!Object.prototype.hasOwnProperty.call(vars, name)) continue
        if (!/^--color-[a-z0-9-]+$/.test(name)) continue
        var value = vars[name]
        if (typeof value !== 'string') continue
        if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) continue
        root.style.setProperty(name, value)
      }
    }
    if (saved.scheme === 'dark' || saved.scheme === 'light') {
      root.style.setProperty('color-scheme', saved.scheme)
    }
    // The one skin there is. `SKINS` in src/theme/themes.ts is the list this has to follow.
    if (saved.skin === 'win95') root.setAttribute('data-skin', saved.skin)
  } catch {
    /* Blocked storage, a half-written key, anything at all: the default theme is already in the
       stylesheet, so there is nothing to recover from. */
  }
})()
