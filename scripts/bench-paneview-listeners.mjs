// Scratch: measures the real DOM cost of the per-PaneView document capture
// listeners (PaneView.tsx:478 pointerdown, :524 wheel) as pane count grows.
import { chromium } from '@playwright/test'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

const results = await page.evaluate(() => {
  const out = []

  const build = (paneCount, tabsPerPane, bubblesPerPane) => {
    document.body.innerHTML = ''
    const root = document.createElement('div')
    root.style.cssText = 'display:flex;flex-wrap:wrap'
    for (let p = 0; p < paneCount; p += 1) {
      const pane = document.createElement('div')
      pane.style.cssText = 'width:380px;height:300px;overflow:hidden;border:1px solid #333'
      const bar = document.createElement('div')
      bar.style.cssText = 'display:flex;overflow-x:auto;height:32px'
      bar.className = 'pane-tab-bar'
      const strip = document.createElement('div')
      strip.className = 'pane-tab-strip'
      strip.style.cssText = 'display:flex;flex:1;overflow-x:auto'
      for (let t = 0; t < tabsPerPane; t += 1) {
        const b = document.createElement('button')
        b.className = 'pane-tab'
        b.dataset.paneTabId = `p${p}t${t}`
        b.style.cssText = 'min-width:120px;height:28px'
        b.innerHTML = `<span>tab ${t}</span><span class="pane-tab-close">x</span>`
        strip.appendChild(b)
      }
      bar.appendChild(strip)
      pane.appendChild(bar)
      const body = document.createElement('div')
      body.style.cssText = 'height:260px;overflow-y:auto'
      for (let m = 0; m < bubblesPerPane; m += 1) {
        const bub = document.createElement('div')
        bub.style.cssText = 'padding:8px;margin:6px;border-radius:8px;background:#222;color:#eee'
        bub.textContent = 'x'.repeat(600)
        body.appendChild(bub)
      }
      pane.appendChild(body)
      root.appendChild(pane)
    }
    document.body.appendChild(root)
    return [...document.querySelectorAll('.pane-tab-strip')]
  }

  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]

  for (const [paneCount, tabsPerPane, bubbles] of [
    [1, 10, 360],
    [3, 10, 360],
    [6, 10, 360],
    [12, 10, 360],
    [24, 10, 360],
  ]) {
    const strips = build(paneCount, tabsPerPane, bubbles)
    document.body.getBoundingClientRect() // settle

    // performance.now() in the renderer is coarsened to ~0.1ms, so every sample
    // is an average over BATCH repetitions of one whole event's worth of work.
    const BATCH = 300
    const timeEvent = (work, batch = BATCH, rounds = 9) => {
      for (let i = 0; i < 50; i += 1) work(i) // warm
      const samples = []
      for (let r = 0; r < rounds; r += 1) {
        const t0 = performance.now()
        for (let i = 0; i < batch; i += 1) work(i)
        samples.push((performance.now() - t0) / batch)
      }
      return median(samples)
    }

    // A) clean-layout fan-out: every pane's handler does one getBoundingClientRect.
    const cleanFanout = timeEvent(() => {
      for (const s of strips) s.getBoundingClientRect()
    })

    // B) dirty-layout fan-out: mutate before EVERY read, so each pane's handler
    //    forces its own synchronous reflow (worst case, N reflows per event).
    const dirtyFanout = timeEvent((i) => {
      for (const s of strips) {
        s.style.paddingLeft = `${i % 2}px`
        s.getBoundingClientRect()
      }
    }, 40)

    // C) one reflow then N clean reads (what actually happens: the first handler
    //    pays the reflow, the rest ride the clean layout).
    const realFanout = timeEvent((i) => {
      strips[0].style.paddingRight = `${i % 2}px`
      for (const s of strips) s.getBoundingClientRect()
    }, 40)

    // D) elementFromPoint (runs at most once per event, for the pane under cursor)
    const efp = timeEvent(() => document.elementFromPoint(200, 20))

    // E) full per-tab rect harvest, only the pane under the cursor does this
    const harvest = timeEvent(() =>
      [...strips[0].querySelectorAll('button[data-pane-tab-id]')].map((b) => ({
        tabId: b.dataset.paneTabId,
        rect: b.getBoundingClientRect(),
      })),
    )

    const cleanSamples = [cleanFanout]
    const dirtySamples = [dirtyFanout]
    const realSamples = [realFanout]
    const efpSamples = [efp]
    const harvestSamples = [harvest]

    out.push({
      paneCount,
      tabsPerPane,
      cleanFanoutMs: median(cleanSamples),
      dirtyFanoutMs: median(dirtySamples),
      realFanoutMs: median(realSamples),
      elementFromPointMs: median(efpSamples),
      tabRectHarvestMs: median(harvestSamples),
    })
  }

  return out
})

for (const r of results) {
  console.log(
    `panes=${String(r.paneCount).padStart(2)} tabs/pane=${r.tabsPerPane}  ` +
      `N clean rects ${(r.cleanFanoutMs*1000).toFixed(1)}us | ` +
      `1 dirty + N clean ${(r.realFanoutMs*1000).toFixed(1)}us | ` +
      `N forced reflows (worst) ${(r.dirtyFanoutMs*1000).toFixed(1)}us | ` +
      `elementFromPoint ${(r.elementFromPointMs*1000).toFixed(1)}us | ` +
      `tab rect harvest ${(r.tabRectHarvestMs*1000).toFixed(1)}us`,
  )
}

await browser.close()
