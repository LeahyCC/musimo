// <m-i n="search" s="18" fill></m-i> — inline Lucide icon (same set as lucide-react in the repo), strokes in currentColor.
;(() => {
  if (customElements.get('m-i')) return
  const cache = {}
  class MI extends HTMLElement {
    static get observedAttributes() {
      return ['n', 's', 'fill']
    }
    connectedCallback() {
      this.r()
    }
    attributeChangedCallback() {
      if (this.isConnected) this.r()
    }
    async r() {
      const n = this.getAttribute('n')
      if (!n) return
      const s = (this.getAttribute('s') || '18') + 'px'
      cache[n] ??= fetch(`https://unpkg.com/lucide-static@0.468.0/icons/${n}.svg`)
        .then((r) => (r.ok ? r.text() : ''))
        .catch(() => {
          delete cache[n]
          return ''
        })
      const t = await cache[n]
      if (this.getAttribute('n') !== n) return
      const tpl = document.createElement('template')
      tpl.innerHTML = t.replace(/<!--[\s\S]*?-->/g, '').trim()
      const svg = tpl.content.querySelector('svg')
      if (!svg) return
      svg.setAttribute('width', s)
      svg.setAttribute('height', s)
      svg.style.display = 'block'
      svg.style.flex = 'none'
      if (this.hasAttribute('fill')) svg.setAttribute('fill', 'currentColor')
      this.replaceChildren(svg)
      this.style.cssText = `display:inline-flex;flex:none;width:${s};height:${s};line-height:0`
    }
  }
  customElements.define('m-i', MI)
})()
