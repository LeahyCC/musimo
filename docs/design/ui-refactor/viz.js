// <m-viz preset="0"></m-viz> — stand-in for the MilkDrop (butterchurn) stage: a 2D feedback visual driven by a fake beat.
;(() => {
  if (customElements.get('m-viz')) return
  class MViz extends HTMLElement {
    static get observedAttributes() {
      return ['preset']
    }
    connectedCallback() {
      this.style.display = 'block'
      this.style.position = this.style.position || 'relative'
      this.c = document.createElement('canvas')
      this.c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
      this.b = document.createElement('canvas')
      this.replaceChildren(this.c)
      this.ro = new ResizeObserver(() => this.size())
      this.ro.observe(this)
      this.size()
      this.t0 = performance.now()
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches
      const loop = (t) => {
        this.draw(t)
        if (!still) this.raf = requestAnimationFrame(loop)
      }
      this.raf = requestAnimationFrame(loop)
    }
    disconnectedCallback() {
      cancelAnimationFrame(this.raf)
      this.ro?.disconnect()
    }
    size() {
      const r = this.getBoundingClientRect(),
        d = Math.min(devicePixelRatio || 1, 1.5)
      const w = Math.max(2, Math.round(r.width * d)),
        h = Math.max(2, Math.round(r.height * d))
      if (this.c.width === w && this.c.height === h) return
      this.c.width = this.b.width = w
      this.c.height = this.b.height = h
    }
    draw(now) {
      const { c, b } = this,
        x = c.getContext('2d'),
        bx = b.getContext('2d')
      const W = c.width,
        H = c.height,
        t = (now - this.t0) / 1000
      const p = Number(this.getAttribute('preset') || 0) % 4
      const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 1.9)), 8)
      const bass = 0.5 + 0.5 * Math.sin(t * 1.3) * Math.sin(t * 0.37)
      bx.clearRect(0, 0, W, H)
      bx.drawImage(c, 0, 0)
      x.fillStyle = 'rgba(2,3,5,0.16)'
      x.fillRect(0, 0, W, H)
      x.save()
      x.translate(W / 2, H / 2)
      x.rotate((p % 2 ? -1 : 1) * (0.006 + bass * 0.01))
      const z = 1.012 + beat * 0.03
      x.scale(z, z)
      x.globalAlpha = 0.9
      x.drawImage(b, -W / 2, -H / 2)
      x.restore()
      const hue = [300, 140, 20, 200][p] + t * 18
      x.save()
      x.translate(W / 2, H / 2)
      x.globalCompositeOperation = 'lighter'
      const R = Math.min(W, H) * (0.18 + bass * 0.08),
        N = 160
      for (let k = 0; k < 2; k++) {
        x.beginPath()
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2
          const wob =
            Math.sin(a * (5 + p * 2) + t * (2 + k)) * 0.22 + Math.sin(a * 3 - t * 1.7) * 0.12
          const r = R * (1 + wob * (0.6 + beat) + k * 0.35)
          const px = Math.cos(a) * r,
            py = Math.sin(a) * r * (p === 2 ? 0.6 : 1)
          i ? x.lineTo(px, py) : x.moveTo(px, py)
        }
        x.strokeStyle = `hsla(${hue + k * 60},90%,${60 + beat * 20}%,${0.55 + beat * 0.4})`
        x.lineWidth = Math.max(1.5, W / 420) * (1 + beat * 2)
        x.stroke()
      }
      if (p === 3)
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2 + t * 0.4,
            r = R * (1.6 + Math.sin(t * 3 + i) * 0.3)
          x.fillStyle = `hsla(${hue + i * 8},90%,65%,0.5)`
          x.beginPath()
          x.arc(Math.cos(a) * r, Math.sin(a) * r, 2 + beat * 5, 0, 7)
          x.fill()
        }
      x.restore()
    }
  }
  customElements.define('m-viz', MViz)
})()
