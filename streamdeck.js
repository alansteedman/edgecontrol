// streamdeck.js — Stream Deck+ controller for edgecontroller
// Pages: home, eom, coyote, estim
import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node'
import { createCanvas, loadImage } from 'canvas'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, readdirSync, existsSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ICONS_DIR   = join(__dir, 'icons')
const WAVEFORMS_PATH = join(__dir, 'waveforms.json')
const AUDIO_DIR   = join(__dir, 'audio')

// ─── Device type display config for home page bottom row ─────────────────────
const DEVICE_TYPE_ORDER = ['eom', 'nimble', 'coyote', 'estim', 'hue', 'shelly']
const DEVICE_DECK_CONFIG = {
  eom:    { label: 'EoM',    color: 'teal',   page: 'eom',    deviceKey: 'eom'    },
  nimble: { label: 'Nimble', color: 'purple', page: 'nimble', deviceKey: 'nimble' },
  coyote: { label: 'Coyote', color: 'orange', page: 'coyote', deviceKey: 'coyote' },
  estim:  { label: 'Estim',  color: 'blue',   page: 'estim',  deviceKey: 'estim'  },
  hue:    { label: 'Hue',    color: 'teal',   page: 'hue',    deviceKey: 'hue'    },
  shelly: { label: 'I/O',    color: 'amber',  page: 'shelly', deviceKey: 'shelly' },
}

// ─── Built-in waveform definitions (matches server BUILTIN_WAVEFORMS) ────────
const BUILTIN_WAVEFORMS = [
  { id:'pulse',     name:'Pulse',     type:'builtin' },
  { id:'breathe',   name:'Breathe',   type:'builtin' },
  { id:'tidal',     name:'Tidal',     type:'builtin' },
  { id:'wave',      name:'Wave',      type:'builtin' },
  { id:'thud',      name:'Thud',      type:'builtin' },
  { id:'flutter',   name:'Flutter',   type:'builtin' },
  { id:'ramp',      name:'Ramp',      type:'builtin' },
  { id:'heartbeat', name:'Heartbeat', type:'builtin' },
  { id:'steps',     name:'Steps',     type:'builtin' },
  { id:'buzz',      name:'Buzz',      type:'builtin' },
]

// Load all waveform items: builtins + custom + audio
function loadCoyoteItems() {
  const items = [...BUILTIN_WAVEFORMS]
  try {
    const store = JSON.parse(readFileSync(WAVEFORMS_PATH, 'utf8'))
    for (const w of store.custom || []) {
      if (w.type === 'audio') {
        items.push({ id: w.id, name: w.name.replace(/\.mp3$/i,''), type:'audio' })
      } else {
        items.push({ id: w.id, name: w.name, type:'custom', bars: framesTo24Bars(w.frames) })
      }
    }
  } catch {}
  return items
}

// Generate bar heights (0–1) for a waveform visualization
function getWaveformBars(id, numBars = 24) {
  const b = []
  for (let i = 0; i < numBars; i++) {
    const t = i / numBars
    let v
    switch (id) {
      case 'pulse':     v = (i % 6 < 3) ? 0.9 : 0.05; break
      case 'breathe':   v = (Math.sin(t * Math.PI * 2 - Math.PI/2) + 1) / 2; break
      case 'tidal':     v = Math.abs(Math.sin(t * Math.PI * 4)) * 0.8 + 0.1; break
      case 'wave':      v = (Math.sin(t*Math.PI*2)*0.5 + Math.sin(t*Math.PI*4+1.57)*0.5) * 0.45 + 0.5; break
      case 'thud':      v = (i % 8 === 0) ? 0.95 : (i % 8 === 1) ? 0.4 : 0.03; break
      case 'flutter':   v = (i % 2 === 0) ? 0.9 : 0.05; break
      case 'ramp':      v = t; break
      case 'heartbeat': { const p=i%8; v=p===0?0.95:p===1?0.45:p===2?0.75:p===3?0.25:0.03; break }
      case 'steps':     v = Math.floor(t * 4) / 3; break
      case 'buzz':      v = 0.85 + Math.sin(i * 1.3) * 0.05; break
      default:          v = 0.5
    }
    b.push(Math.max(0.03, Math.min(1, v)))
  }
  return b
}

// Downsample custom waveform frames to 24 bar heights (0-1)
function framesTo24Bars(frames) {
  if (!frames || !frames.length) return Array(24).fill(0.3)
  const n = 24
  return Array.from({length: n}, (_, i) => {
    const fi = Math.floor(i / n * frames.length)
    const segs = frames[fi]?.segs || []
    const avg = segs.length ? segs.reduce((s, sg) => s + (sg.a || 0), 0) / segs.length : 0
    return Math.max(0.03, avg / 100)
  })
}

// Pre-load device PNGs at startup (non-fatal if missing)
const deviceIcons = {}
async function loadDeviceIcons() {
  const files = { eom: 'EoM.png', coyote: 'coyote.png', nimble: 'nimble.png', estim: 'estim.png' }
  for (const [key, file] of Object.entries(files)) {
    try {
      deviceIcons[key] = await loadImage(join(ICONS_DIR, file))
      console.log(`[deck] icon loaded: ${file}`)
    } catch(e) {
      console.warn(`[deck] icon missing: ${file}`)
    }
  }
  try {
    deviceIcons.hue = await loadImage(join(__dir, 'public', 'hue-logo.svg'))
    console.log('[deck] icon loaded: hue-logo.svg')
  } catch(e) {
    console.warn('[deck] icon missing: hue-logo.svg')
  }
  try {
    deviceIcons.shelly = await loadImage(join(__dir, 'public', 'icons', 'shelly.svg'))
    console.log('[deck] icon loaded: shelly.svg')
  } catch(e) {
    console.warn('[deck] icon missing: shelly.svg')
  }
}

// ─── Colour palette ───────────────────────────────────────────────────────
const THEME = {
  red:    { bg: '#3d0a0a', accent: '#c0392b' },
  green:  { bg: '#0a2e0a', accent: '#27ae60' },
  blue:   { bg: '#0a1a3d', accent: '#2980b9' },
  purple: { bg: '#1a0a3d', accent: '#8e44ad' },
  orange: { bg: '#3d1a00', accent: '#d35400' },
  teal:   { bg: '#0a2e2e', accent: '#16a085' },
  amber:  { bg: '#2a1e00', accent: '#f0c040' },
  dim:    { bg: '#0d0d0d', accent: '#333' },
}

// ─── Rendering helpers ────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r); ctx.closePath()
}

function lighten(hex, amt) {
  const n = parseInt(hex.replace('#',''), 16)
  const r = Math.min(255, (n >> 16) + amt)
  const g = Math.min(255, ((n >> 8) & 0xff) + amt)
  const b = Math.min(255, (n & 0xff) + amt)
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
}

function rgba(canvas) {
  const ctx = canvas.getContext('2d')
  return Buffer.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer)
}

// ─── Draw house icon ─────────────────────────────────────────────────────
function drawHouseIcon(ctx, cx, cy, size) {
  const w = size, h = size
  const x = cx - w/2, y = cy - h/2

  // Roof (triangle) — warm red
  ctx.beginPath()
  ctx.moveTo(cx, y)                        // apex
  ctx.lineTo(x + w, y + h * 0.45)         // right eave
  ctx.lineTo(x,     y + h * 0.45)         // left eave
  ctx.closePath()
  ctx.fillStyle = '#c0392b'; ctx.fill()

  // Walls — warm white/cream
  ctx.fillStyle = '#ecf0f1'
  ctx.fillRect(x + w*0.1, y + h*0.42, w*0.8, h*0.58)

  // Door — brown, centred
  ctx.fillStyle = '#7f4b1a'
  const dw = w*0.22, dh = h*0.34
  ctx.fillRect(cx - dw/2, y + h - dh, dw, dh)

  // Door knob
  ctx.beginPath()
  ctx.arc(cx + dw*0.18, y + h - dh*0.45, 2, 0, Math.PI*2)
  ctx.fillStyle = '#f1c40f'; ctx.fill()

  // Left window
  ctx.fillStyle = '#85c1e9'
  ctx.fillRect(x + w*0.15, y + h*0.52, w*0.18, w*0.18)
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
  ctx.strokeRect(x + w*0.15, y + h*0.52, w*0.18, w*0.18)

  // Right window
  ctx.fillStyle = '#85c1e9'
  ctx.fillRect(x + w*0.67, y + h*0.52, w*0.18, w*0.18)
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
  ctx.strokeRect(x + w*0.67, y + h*0.52, w*0.18, w*0.18)
}

// ─── Draw stop sign octagon ──────────────────────────────────────────────
function drawStopSign(ctx, cx, cy, r) {
  const sides = 8
  const offset = Math.PI / 8  // rotate so flat edge is at top/bottom
  ctx.beginPath()
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + offset
    const x = cx + Math.cos(angle) * r
    const y = cy + Math.sin(angle) * r
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fillStyle = '#c0392b'; ctx.fill()
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
  ctx.font = 'bold 18px sans-serif'
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('STOP', cx, cy)
}

// ─── Draw single-channel icon (4 separate dots) ──────────────────────────
// Layout: C1·A(red) top-left, C2·A(purple) top-right
//         C1·B(orange) bot-left, C2·B(blue) bot-right
function drawSingleIcon(ctx, cx, cy) {
  const CH = ['#e74c3c', '#9b59b6', '#e67e22', '#3498db']  // TL, TR, BL, BR
  const r = 9, dx = 19, dy = 15
  const pos = [[cx-dx,cy-dy],[cx+dx,cy-dy],[cx-dx,cy+dy],[cx+dx,cy+dy]]
  pos.forEach(([x,y], i) => {
    // Subtle fill + coloured ring
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2)
    ctx.fillStyle = CH[i] + '30'; ctx.fill()
    ctx.strokeStyle = CH[i]; ctx.lineWidth = 2.5; ctx.stroke()
  })
}

// ─── Draw group-channel icon (4 dots, left pair linked, right pair linked) ─
function drawGroupIcon(ctx, cx, cy) {
  const CH = ['#e74c3c', '#9b59b6', '#e67e22', '#3498db']
  const r = 9, dx = 19, dy = 15
  const pos = [[cx-dx,cy-dy],[cx+dx,cy-dy],[cx-dx,cy+dy],[cx+dx,cy+dy]]

  // Link lines first (behind dots) — left column, right column
  ctx.lineCap = 'round'; ctx.lineWidth = 3
  // Left column (C1·A ↔ C1·B)
  const lg = ctx.createLinearGradient(pos[0][0], pos[0][1], pos[2][0], pos[2][1])
  lg.addColorStop(0, '#e74c3c'); lg.addColorStop(1, '#e67e22')
  ctx.strokeStyle = lg
  ctx.beginPath()
  ctx.moveTo(pos[0][0], pos[0][1] + r + 1)
  ctx.lineTo(pos[2][0], pos[2][1] - r - 1)
  ctx.stroke()
  // Right column (C2·A ↔ C2·B)
  const rg = ctx.createLinearGradient(pos[1][0], pos[1][1], pos[3][0], pos[3][1])
  rg.addColorStop(0, '#9b59b6'); rg.addColorStop(1, '#3498db')
  ctx.strokeStyle = rg
  ctx.beginPath()
  ctx.moveTo(pos[1][0], pos[1][1] + r + 1)
  ctx.lineTo(pos[3][0], pos[3][1] - r - 1)
  ctx.stroke()

  // Dots on top — solid fill + white ring
  pos.forEach(([x,y], i) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2)
    ctx.fillStyle = CH[i]; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
  })
}

// ─── Draw a 200×100 Coyote channel LCD segment ───────────────────────────
function renderCoyoteChannelLcd({ label, color, intensity, waveform, connected, selected, grouped, speed, speedMode }) {
  const W = 200, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  if (!connected) {
    ctx.fillStyle = '#222'; ctx.font = '10px monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(label, W/2, 14)
    ctx.fillStyle = '#333'; ctx.font = '9px monospace'
    ctx.fillText('offline', W/2, H/2)
    return rgba(canvas)
  }

  // Selection mode highlight border
  if (selected) {
    ctx.strokeStyle = color; ctx.lineWidth = 2
    ctx.strokeRect(1, 1, W-2, H-2)
    ctx.fillStyle = color + '15'
    ctx.fillRect(1, 1, W-2, H-2)
  }

  // Channel label (top left)
  ctx.font = 'bold 11px monospace'; ctx.fillStyle = color
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  ctx.fillText(label, 8, 6)

  // Selection indicator (top right)
  if (selected) {
    ctx.font = 'bold 9px monospace'; ctx.fillStyle = color
    ctx.textAlign = 'right'
    ctx.fillText(grouped ? '● GRP SELECT' : '● SELECT', W - 6, 6)
  }

  // Group indicator (top right, when grouped but not selected)
  if (grouped && !selected) {
    ctx.font = '8px monospace'; ctx.fillStyle = '#16a085'
    ctx.textAlign = 'right'
    ctx.fillText('⬡ GRP', W - 6, 6)
  }

  // Arc (left side) — shows intensity normally, speed when encoder held
  const cx = 52, cy = 58, r = 32
  const startA = Math.PI * 0.75, sweep = Math.PI * 1.5

  if (speedMode) {
    // Speed arc: log2 scale 0.25→4 maps to 0→100%
    const spd = speed ?? 1
    const pct = Math.min(1, Math.max(0, (Math.log2(spd) + 2) / 4))
    const arcColor = '#16a085'

    ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + sweep)
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke()
    if (pct > 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + pct * sweep)
      ctx.strokeStyle = arcColor; ctx.lineWidth = 7; ctx.stroke()
      ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + pct * sweep)
      ctx.strokeStyle = arcColor; ctx.lineWidth = 12; ctx.globalAlpha = 0.2; ctx.stroke()
      ctx.globalAlpha = 1
    }
    // Speed label inside arc
    const spdStr = spd === 1 ? '×1' : spd < 1 ? `÷${+(1/spd).toFixed(2)}` : `×${spd}`
    ctx.font = `bold ${spdStr.length > 3 ? 13 : 16}px monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = arcColor; ctx.fillText(spdStr, cx, cy)
    ctx.font = '8px monospace'; ctx.fillStyle = '#16a085'
    ctx.textBaseline = 'top'; ctx.fillText('SPD', cx, cy + r + 4)

    // Hint text
    ctx.font = '8px monospace'; ctx.fillStyle = '#555'
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
    ctx.fillText('hold+turn', 8, H - 4)
  } else {
    // Normal: intensity arc
    const pct = Math.min(1, intensity / 200)

    ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + sweep)
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke()
    if (pct > 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + pct * sweep)
      ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.stroke()
      ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + pct * sweep)
      ctx.strokeStyle = color; ctx.lineWidth = 12; ctx.globalAlpha = 0.15; ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.font = `bold ${intensity >= 100 ? 18 : 22}px monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = color; ctx.fillText(`${intensity}`, cx, cy)
    ctx.font = '8px monospace'; ctx.fillStyle = '#444'
    ctx.textBaseline = 'top'; ctx.fillText('%', cx, cy + r + 4)

    // Speed badge (top right of arc area) when speed ≠ 1
    if (speed && speed !== 1) {
      const spdStr = speed < 1 ? `÷${+(1/speed).toFixed(1)}` : `×${speed}`
      ctx.font = 'bold 8px monospace'; ctx.fillStyle = '#16a085'
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
      ctx.fillText(spdStr, 8, H - 4)
    }
  }

  // waveform is already resolved to a display name by the caller
  const wfDisplay = waveform || '—'
  const fontSize = wfDisplay.length > 8 ? 11 : 13
  ctx.font = `bold ${fontSize}px monospace`
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
  ctx.fillStyle = selected ? '#fff' : '#888'
  if (wfDisplay.length > 10) {
    const mid = Math.floor(wfDisplay.length / 2)
    const sp = wfDisplay.lastIndexOf(' ', mid) > 0 ? wfDisplay.lastIndexOf(' ', mid) : mid
    ctx.fillText(wfDisplay.slice(0, sp), W - 8, cy - 8)
    ctx.fillText(wfDisplay.slice(sp+1 || sp), W - 8, cy + 8)
  } else {
    ctx.fillText(wfDisplay, W - 8, cy)
  }

  return rgba(canvas)
}

// ─── Draw waveform bar-chart key (120×120) ───────────────────────────────
function renderWaveformKey(item, active) {
  const S = 120
  const canvas = createCanvas(S, S)
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = '#000'
  roundRect(ctx, 0, 0, S, S, 10); ctx.fill()

  // Border
  ctx.strokeStyle = active ? '#3498db' : '#444'
  ctx.lineWidth = active ? 2.5 : 1
  roundRect(ctx, 1, 1, S-2, S-2, 10); ctx.stroke()
  if (active) {
    ctx.save(); ctx.shadowColor='#3498db'; ctx.shadowBlur=12
    ctx.strokeStyle='#3498dbaa'; ctx.lineWidth=3
    roundRect(ctx, 1, 1, S-2, S-2, 10); ctx.stroke(); ctx.restore()
  }

  if (item.type === 'audio') {
    // Music note — smaller to leave room for text
    ctx.font = '22px sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = active ? '#3498db' : '#888'
    ctx.fillText('♪', S/2, S*0.24)

    // Split name into two lines — break at space nearest midpoint
    const name = item.name
    let line1 = name, line2 = ''
    const mid = Math.floor(name.length / 2)
    const spaceAfter  = name.indexOf(' ', mid)
    const spaceBefore = name.lastIndexOf(' ', mid)
    const breakAt = spaceAfter >= 0 && (spaceBefore < 0 || spaceAfter - mid < mid - spaceBefore)
      ? spaceAfter : spaceBefore
    if (breakAt > 0) {
      line1 = name.slice(0, breakAt)
      line2 = name.slice(breakAt + 1)
    } else if (name.length > 10) {
      line1 = name.slice(0, 9) + '-'
      line2 = name.slice(9)
    }
    // Truncate if still too long
    if (line1.length > 11) line1 = line1.slice(0, 10) + '…'
    if (line2.length > 11) line2 = line2.slice(0, 10) + '…'

    ctx.font = 'bold 12px sans-serif'
    ctx.textAlign = 'center'; ctx.fillStyle = active ? '#fff' : '#bbb'
    ctx.textBaseline = 'middle'
    ctx.fillText(line1, S/2, S*0.57)
    ctx.fillText(line2, S/2, S*0.76)
    return rgba(canvas)
  }

  if (item.type === 'custom') {
    // Custom waveform — bar chart from actual frame data
    const bars = item.bars || Array(24).fill(0.3)
    const numBars = bars.length
    const barArea = { x: 8, y: 12, w: S - 16, h: S - 44 }
    const barW = (barArea.w / numBars) * 0.72
    const gap = (barArea.w / numBars) * 0.28
    bars.forEach((v, i) => {
      const barH = Math.max(2, v * barArea.h)
      const x = barArea.x + i * (barW + gap)
      const y = barArea.y + barArea.h - barH
      const grad = ctx.createLinearGradient(0, y, 0, y + barH)
      grad.addColorStop(0, active ? '#5dade2' : '#2e86c1')
      grad.addColorStop(1, active ? '#1a5276' : '#0d2b45')
      ctx.fillStyle = grad
      ctx.fillRect(x, y, barW, barH)
    })
    const name = item.name.length > 10 ? item.name.slice(0,9)+'…' : item.name
    ctx.font = `bold ${name.length > 8 ? 9 : 10}px sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillStyle = active ? '#fff' : '#aaa'
    ctx.fillText(name, S/2, S - 4)
    return rgba(canvas)
  }

  // Built-in — bar chart visualization
  const bars = getWaveformBars(item.id)
  const numBars = bars.length
  const barArea = { x: 8, y: 12, w: S - 16, h: S - 44 }
  const barW = (barArea.w / numBars) * 0.72
  const gap = (barArea.w / numBars) * 0.28

  bars.forEach((v, i) => {
    const barH = Math.max(2, v * barArea.h)
    const x = barArea.x + i * (barW + gap)
    const y = barArea.y + barArea.h - barH
    // Gradient fill matching web page (cyan/blue)
    const grad = ctx.createLinearGradient(0, y, 0, y + barH)
    grad.addColorStop(0, active ? '#5dade2' : '#2e86c1')
    grad.addColorStop(1, active ? '#1a5276' : '#0d2b45')
    ctx.fillStyle = grad
    ctx.fillRect(x, y, barW, barH)
  })

  // Label
  ctx.font = `bold ${item.name.length > 8 ? 9 : 10}px sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillStyle = active ? '#fff' : '#bbb'
  ctx.fillText(item.name.toUpperCase(), S/2, S - 8)

  return rgba(canvas)
}

// ─── Draw a single 120×120 button key ────────────────────────────────────
function renderKey({ icon='', label='', color='dim', active=false, value=null, valueColor='#fff', valueLarge=false, sublabel=null, deviceKey=null, stopSign=false, houseIcon=false, singleIcon=false, groupIcon=false, bg=null }) {
  const S = 120
  const canvas = createCanvas(S, S)
  const ctx = canvas.getContext('2d')
  const { accent } = THEME[color] || THEME.dim
  const isDim = color === 'dim'
  const img = deviceKey ? deviceIcons[deviceKey] : null
  const iconScale = deviceKey === 'coyote' ? 0.75 : 1.0  // Coyote logo 25% smaller

  // Black background always
  ctx.fillStyle = bg || '#000'
  roundRect(ctx, 0, 0, S, S, 10); ctx.fill()

  // Border — light grey normally, accent colour when active
  ctx.strokeStyle = active ? lighten(accent, 50) : '#444'
  ctx.lineWidth = active ? 2.5 : 1
  roundRect(ctx, 1, 1, S-2, S-2, 10); ctx.stroke()

  // Active glow
  if (active && !isDim) {
    ctx.save()
    ctx.shadowColor = accent; ctx.shadowBlur = 14
    ctx.strokeStyle = accent + 'aa'; ctx.lineWidth = 3
    roundRect(ctx, 1, 1, S-2, S-2, 10); ctx.stroke()
    ctx.restore()
  }

  ctx.globalAlpha = isDim ? 0.35 : 1

  // Stop sign
  if (stopSign) {
    drawStopSign(ctx, S/2, label ? S/2 - 8 : S/2, 36)
  }
  // House icon
  if (houseIcon) {
    drawHouseIcon(ctx, S/2, label ? S/2 - 10 : S/2, label ? 56 : 64)
  }
  // Single-channel icon (4 separate dots)
  if (singleIcon) {
    drawSingleIcon(ctx, S/2, label ? S/2 - 10 : S/2)
  }
  // Group-channel icon (4 dots, linked in pairs)
  if (groupIcon) {
    drawGroupIcon(ctx, S/2, label ? S/2 - 10 : S/2)
  }
  // Device logo PNG — scale to fit, centred, leaving room for label
  if (img) {
    const pad = 12
    const maxH = (label ? S - 30 : S - pad * 2) * iconScale
    const maxW = (S - pad * 2) * iconScale
    const scale = Math.min(maxW / img.width, maxH / img.height)
    const w = img.width * scale, h = img.height * scale
    const x = (S - w) / 2
    const y = label ? (S - 26 - h) / 2 : (S - h) / 2
    ctx.drawImage(img, x, y, w, h)
  }
  // Emoji icon fallback (for non-device buttons)
  else if (icon) {
    ctx.font = '48px "Noto Color Emoji", serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = 'white'
    const iconY = label ? S*0.38 : S*0.5
    ctx.fillText(icon, S/2, iconY)
  }

  // Big value number
  if (value !== null) {
    const hasAbove = icon || img || stopSign || houseIcon
    if (valueLarge) {
      const s = String(value)
      ctx.font = `bold ${s.length > 3 ? 32 : s.length > 2 ? 40 : 52}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = valueColor
      ctx.fillText(s, S/2, label ? S * 0.44 : S * 0.5)
    } else {
      ctx.font = `bold ${String(value).length > 3 ? 16 : 20}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = valueColor
      ctx.fillText(String(value), S/2, S * (hasAbove ? 0.62 : 0.46))
    }
  }

  // Sublabel
  if (sublabel) {
    ctx.font = '9px sans-serif'; ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'; ctx.fillStyle = '#666'
    ctx.fillText(sublabel.toUpperCase(), S/2, S - 22)
  }

  // Main label
  if (label) {
    ctx.font = `bold ${label.length > 8 ? 9 : 10}px sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillStyle = isDim ? '#444' : (active ? '#fff' : '#bbb')
    ctx.fillText(label.toUpperCase(), S/2, S - 8)
  }

  ctx.globalAlpha = 1
  return rgba(canvas)
}

// ─── Draw a 200×100 encoder LCD segment ──────────────────────────────────
function renderEncoderLcd({ label='', value=0, max=100, unit='%', color='#888', dim=false, selected=false, modeName='' }) {
  const W = 200, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  // Selection border — used by estim channel selection
  if (selected) {
    ctx.strokeStyle = color; ctx.lineWidth = 2
    ctx.strokeRect(1, 1, W-2, H-2)
    ctx.fillStyle = color + '18'; ctx.fillRect(2, 2, W-4, H-4)
    ctx.font = 'bold 8px monospace'; ctx.fillStyle = color
    ctx.textAlign = 'right'; ctx.textBaseline = 'top'
    ctx.fillText('● SET MODE', W-6, 6)
  }

  if (dim) {
    ctx.fillStyle = '#1a1a1a'; ctx.font = 'bold 18px monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('—', W/2, H/2)
    return rgba(canvas)
  }

  const pct = Math.min(1, Math.max(0, value / max))
  const cx = W/2, cy = H * 0.56, r = 30
  const startA = Math.PI * 0.75, sweep = Math.PI * 1.5

  // Track
  ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + sweep)
  ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke()

  // Fill arc
  if (pct > 0) {
    ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + pct * sweep)
    ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.stroke()
    // Glow
    ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + pct * sweep)
    ctx.strokeStyle = color; ctx.lineWidth = 12; ctx.globalAlpha = 0.15; ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Value text
  const dispVal = unit === 'ms' ? (value >= 1000 ? `${(value/1000).toFixed(1)}s` : `${value}ms`) : `${value}${unit}`
  ctx.font = `bold ${dispVal.length > 4 ? 14 : 17}px monospace`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillStyle = color; ctx.fillText(dispVal, cx, cy)

  // Label
  ctx.font = '8px monospace'; ctx.textAlign = 'center'
  ctx.textBaseline = 'top'; ctx.fillStyle = '#444'
  ctx.fillText(label.toUpperCase(), W/2, 4)

  // Mode name — shown at bottom, e.g. on estim page
  if (modeName) {
    ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'; ctx.fillStyle = color + 'cc'
    ctx.fillText(modeName.toUpperCase(), W/2, H - 3)
  }

  return rgba(canvas)
}

// ─── HOME page LCD strip (800×100) — device status ────────────────────────
function renderHomeLcd(devices, devicePageOffset) {
  const W = 800, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  const activeTypes = getActiveDeviceTypes(devices)
  const visibleTypes = activeTypes.slice(devicePageOffset, devicePageOffset + 4)
  const devList = Object.values(devices)

  if (!visibleTypes.length) {
    ctx.font = '11px monospace'; ctx.fillStyle = '#333'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('No devices configured', W/2, H/2)
    return rgba(canvas)
  }

  visibleTypes.forEach((type, i) => {
    const cfg = DEVICE_DECK_CONFIG[type]
    const d = devList.find(d => d.type === type)
    const status = d ? d.status : 'offline'
    const dotColor = status === 'connected' ? '#27ae60'
                   : status === 'connecting' ? '#f39c12'
                   : status === 'error' ? '#c0392b'
                   : '#444'
    const colW = W / Math.min(4, visibleTypes.length)
    const x = colW * i + 12

    // Divider
    if (i > 0) {
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(colW * i, 8); ctx.lineTo(colW * i, H - 8); ctx.stroke()
    }

    // Dot indicator
    ctx.beginPath(); ctx.arc(x + 5, 24, 5, 0, Math.PI*2)
    ctx.fillStyle = dotColor; ctx.fill()

    // Name
    ctx.font = 'bold 11px monospace'; ctx.fillStyle = '#888'
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
    ctx.fillText(cfg.label, x + 16, 24)

    // Status
    ctx.font = '10px monospace'; ctx.fillStyle = dotColor
    ctx.fillText(status.toUpperCase(), x, 44)

    // Extra info if connected
    if (d && d.status === 'connected') {
      ctx.font = '9px monospace'; ctx.fillStyle = '#555'
      if (type === 'eom' && d._mode) ctx.fillText(d._mode.toUpperCase(), x, 60)
      if (type === 'coyote') ctx.fillText(`A:${d.channels?.A?.intensity||0}%  B:${d.channels?.B?.intensity||0}%`, x, 60)
      if (type === 'hue') ctx.fillText(d.bridgeName || d.ip || '', x, 60)
    }
  })

  // Page indicator if scrollable
  if (activeTypes.length > 4) {
    const curPage = Math.floor(devicePageOffset / 4) + 1
    const totalPages = Math.ceil(activeTypes.length / 4)
    ctx.font = '8px monospace'; ctx.fillStyle = '#333'
    ctx.textAlign = 'right'; ctx.textBaseline = 'top'
    ctx.fillText(`${curPage}/${totalPages}`, W - 6, 4)
  }

  return rgba(canvas)
}

// ─── EoM LCD strip — arousal top, knob labels/values bottom ─────────────
function renderNimbleLcd(dev) {
  const W = 800, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  const conn = dev?.status === 'connected'
  const spm    = conn ? Math.round((dev.oscSpeed ?? 0.5) * 60) : 0
  const depth  = conn ? (dev.oscDepth  ?? 500) : 0
  const nurture= conn ? (dev.nsTexture ?? 0)   : 0
  const nature = conn ? (dev.nsNature  ?? 20)  : 0

  const knobs = [
    { label:'SPEED',   value: spm,    max:300,  unit:' SPM', color:'#4fc3f7' },
    { label:'DEPTH',   value: depth,  max:1000, unit:'',     color:'#a78bfa' },
    { label:'NURTURE', value: nurture,max:200,  unit:'',     color:'#f472b6' },
    { label:'NATURE',  value: nature, max:50,   unit:' Hz',  color:'#fb923c' },
  ]

  knobs.forEach((k, i) => {
    const cx = i * 200 + 100, cy = 58, r = 30
    const startA = Math.PI * 0.75, sweep = Math.PI * 1.5
    const pct = conn ? Math.min(1, Math.max(0, k.value / k.max)) : 0

    // Label
    ctx.font = '8px monospace'; ctx.textAlign = 'center'
    ctx.textBaseline = 'top'; ctx.fillStyle = '#444'
    ctx.fillText(k.label, cx, 4)

    if (!conn) {
      ctx.fillStyle = '#1a1a1a'; ctx.font = 'bold 18px monospace'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('—', cx, cy)
      return
    }

    // Track
    ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + sweep)
    ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke()

    // Fill arc
    if (pct > 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + pct * sweep)
      ctx.strokeStyle = k.color; ctx.lineWidth = 7; ctx.stroke()
      ctx.beginPath(); ctx.arc(cx, cy, r, startA, startA + pct * sweep)
      ctx.strokeStyle = k.color; ctx.lineWidth = 12; ctx.globalAlpha = 0.15; ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Value
    const disp = `${k.value}${k.unit}`
    ctx.font = `bold ${disp.length > 6 ? 12 : 15}px monospace`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = k.color; ctx.fillText(disp, cx, cy)

    // Divider
    if (i < 3) {
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(i * 200 + 200, 10); ctx.lineTo(i * 200 + 200, 90); ctx.stroke()
    }
  })

  return rgba(canvas)
}

function renderEomLcd(eomDev) {
  const W = 800, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  const readings = eomDev?._readings || {}
  const cfg      = eomDev?._config   || {}
  const mode     = eomDev?._mode     || 'manual'
  const arousal  = Math.round((readings.arousal || 0) / 255 * 100)
  const motor    = readings.motor || 0
  const thresh   = cfg.sensitivity_threshold ?? 128
  const threshPct = thresh / 255
  const denials  = eomDev?._denialCount || 0
  const coolRaw  = cfg.cooldown_delay_ms ?? 1000
  const barX = 10, barW = W - 20

  // ── Top section: arousal ──────────────────────────────────────────────

  // Status row: AROUSAL % | MODE | MOTOR %
  ctx.font = 'bold 9px monospace'; ctx.textBaseline = 'top'
  ctx.fillStyle = '#2ecc71'; ctx.textAlign = 'left'
  ctx.fillText(`AROUSAL  ${arousal}%`, barX, 4)
  ctx.fillStyle = mode === 'automatic' ? '#27ae60' : '#555'
  ctx.textAlign = 'center'
  ctx.fillText(mode === 'automatic' ? '● AUTO' : '○ MANUAL', W / 2, 4)
  ctx.fillStyle = '#f39c12'; ctx.textAlign = 'right'
  ctx.fillText(`MOTOR  ${motor}%`, W - barX, 4)

  // Arousal bar — taller now that knob values are smaller
  const barY = 17, barH = 22
  ctx.fillStyle = '#111'; ctx.fillRect(barX, barY, barW, barH)
  if (arousal > 0) {
    const aGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0)
    aGrad.addColorStop(0, '#27ae60'); aGrad.addColorStop(0.6, '#f39c12'); aGrad.addColorStop(1, '#c0392b')
    ctx.fillStyle = aGrad
    ctx.fillRect(barX, barY, barW * arousal / 100, barH)
  }
  // Threshold tick
  const tickX = barX + barW * threshPct
  ctx.fillStyle = '#e74c3c'; ctx.fillRect(tickX - 1, barY - 2, 2, barH + 4)

  // Denied count (right of status row, if any)
  if (denials > 0) {
    ctx.font = '8px monospace'; ctx.fillStyle = '#c0392b'
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'
    ctx.fillText(`DENIED: ${denials}`, W - barX, barY - 2)
  }

  // ── Divider ───────────────────────────────────────────────────────────
  ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, 46); ctx.lineTo(W, 46); ctx.stroke()

  // ── Bottom section: knob labels + values ─────────────────────────────
  const knobs = [
    { label: 'MOTOR SPEED', value: `${eomDev?._motorSpeed ?? 0}%`, color: '#95a5a6' },
    { label: 'THRESHOLD',   value: `${thresh}`,                    color: '#1abc9c' },
    { label: 'DECAY',       value: `${cfg.arousal_decay_rate ?? 100}`, color: '#3498db' },
    { label: 'COOL OFF',    value: coolRaw >= 1000 ? `${(coolRaw/1000).toFixed(1)}s` : `${coolRaw}ms`, color: '#e67e22' },
  ]
  knobs.forEach((k, i) => {
    const cx = i * 200 + 100
    if (i > 0) {
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(i * 200, 48); ctx.lineTo(i * 200, H); ctx.stroke()
    }
    // Value — smaller font so arousal section has more room
    ctx.font = `bold ${k.value.length > 5 ? 11 : k.value.length > 3 ? 13 : 15}px monospace`
    ctx.fillStyle = k.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(k.value, cx, 66)
    // Label — white so it's readable
    ctx.font = '8px monospace'; ctx.fillStyle = '#ccc'
    ctx.textBaseline = 'bottom'
    ctx.fillText(k.label, cx, H - 2)
  })

  return rgba(canvas)
}

// ─── Coyote LCD strip — per-channel live waveforms ────────────────────────
function renderCoyoteLcd(coyoteDev, tick) {
  const W = 800, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  const QW = W / 2  // two channels: A and B
  const channels = [
    { label: 'CH·A', color: '#e74c3c', intensity: coyoteDev?.channels?.A?.intensity || 0, wave: coyoteDev?.channels?.A?.waveform || 'sine' },
    { label: 'CH·B', color: '#e67e22', intensity: coyoteDev?.channels?.B?.intensity || 0, wave: coyoteDev?.channels?.B?.waveform || 'sine' },
  ]

  channels.forEach((ch, i) => {
    const ox = QW * i
    const t = tick * 0.05

    // Subtle tinted background
    ctx.fillStyle = i === 0 ? '#1a050500' : '#1a0a0000'
    ctx.fillRect(ox, 0, QW, H)

    // Divider
    if (i > 0) {
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(ox, 6); ctx.lineTo(ox, H-6); ctx.stroke()
    }

    // Waveform
    ctx.strokeStyle = ch.intensity > 0 ? ch.color : '#1a1a1a'
    ctx.lineWidth = 2; ctx.beginPath()
    const amp = (ch.intensity / 100) * (H * 0.35)
    for (let x = 0; x < QW - 4; x++) {
      const tp = x / (QW - 4) + t + i * 0.5
      let y
      switch (ch.wave) {
        case 'sine':  y = H/2 + Math.sin(tp * Math.PI * 6) * amp; break
        case 'pulse': y = (tp % 0.5 < 0.25) ? H/2 - amp : H/2 + amp; break
        case 'tidal': y = H/2 + Math.sin(tp*Math.PI*2) * Math.sin(tp*Math.PI*8) * amp; break
        case 'wave':  y = H/2 + Math.sin(tp*Math.PI*5) * amp * Math.abs(Math.sin(tp)); break
        default:      y = H/2
      }
      x === 0 ? ctx.moveTo(ox + 4 + x, y) : ctx.lineTo(ox + 4 + x, y)
    }
    ctx.stroke()

    // Label + intensity
    ctx.font = 'bold 11px monospace'; ctx.fillStyle = ch.color
    ctx.textBaseline = 'top'; ctx.fillText(ch.label, ox + 8, 6)
    ctx.font = '10px monospace'; ctx.fillStyle = '#888'
    ctx.fillText(`${ch.intensity}%  ${ch.wave}`, ox + 8, H - 18)
  })

  return rgba(canvas)
}

// Resolve a waveform ID to a human-readable display name.
// Falls back to parsing the ID for audio files, or returns the ID itself for unknowns.
function resolveWfName(id, items = []) {
  if (!id || id === '—') return '—'
  const found = items.find(it => it.id === id)
  if (found) return found.name
  // Fallback: strip audio ID prefix/extension
  return id.replace(/^audio-[^-]+-\d+-/, '').replace(/_/g, ' ').replace(/\.mp3$/i, '').trim() || id
}

// ─── Coyote GROUP MODE LCD strip — up to 4 groups, one column per group (one knob each)
// viewOffset = index of first group shown (shown in batches of 4)
// selectedIdx = 0-3 (which column is selected for waveform assignment) | null (none)
function renderCoyoteGroupModeLcd(groups, devices, viewOffset, selectedIdx = null, items = [], speedModes = []) {
  const W = 800, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  const colors = ['#e74c3c', '#e67e22', '#9b59b6', '#3498db']
  const hasPrev = viewOffset > 0
  const hasNext = (viewOffset + 4) < groups.length

  for (let gi = 0; gi < 4; gi++) {
    const groupIdx = viewOffset + gi
    const group    = groups[groupIdx]
    const ox       = gi * 200
    const color    = colors[gi]
    const isSelected = (selectedIdx === gi)

    // Column divider
    if (gi > 0) {
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(ox, 4); ctx.lineTo(ox, H - 4); ctx.stroke()
    }

    if (!group) {
      ctx.font = '10px monospace'; ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'; ctx.fillStyle = '#1a1a1a'
      ctx.fillText('—', ox + 100, H / 2)
      continue
    }

    // Selection highlight border
    if (isSelected) {
      ctx.strokeStyle = color; ctx.lineWidth = 2
      ctx.strokeRect(ox + 1, 1, 198, H - 2)
      ctx.fillStyle = color + '15'; ctx.fillRect(ox + 1, 1, 198, H - 2)
    }

    // Gather all channels in this group
    const allChs = group.channels || []
    const devCount = allChs.length
    let totalIntensity = 0, connCount = 0
    let waveform = '', speed = 1
    for (const {deviceId, channel} of allChs) {
      const dev = devices[deviceId]
      if (dev?.status === 'connected') {
        totalIntensity += dev.channels?.[channel]?.intensity ?? 0
        connCount++
        if (!waveform && dev.channels?.[channel]?.waveform) waveform = dev.channels[channel].waveform
        if (speed === 1 && dev.channels?.[channel]?.speed) speed = dev.channels[channel].speed
      }
    }
    const intensity = connCount > 0 ? Math.round(totalIntensity / connCount) : 0
    const anyConn   = connCount > 0
    const isSpeedMode = !!speedModes[gi]

    // Group name label (top left)
    const pageLbl = groups.length > 4 ? ` ${groupIdx+1}/${groups.length}` : ''
    const nameStr = group.name + pageLbl
    ctx.font = `bold ${nameStr.length > 9 ? 9 : 11}px monospace`
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.fillStyle = isSelected ? '#fff' : color
    ctx.fillText(nameStr.length > 11 ? nameStr.slice(0,10)+'…' : nameStr, ox + 8, 6)

    // Device count badge (top right)
    ctx.font = '8px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'top'
    ctx.fillStyle = isSelected ? color : '#555'
    ctx.fillText(`×${devCount}`, ox + 194, 6)

    // Arc dial (left side) — exactly matches single mode renderCoyoteChannelLcd style
    const acx = ox + 52, acy = 58, r = 32
    const startA = Math.PI * 0.75, sweep = Math.PI * 1.5

    if (isSpeedMode) {
      const pct = Math.min(1, Math.max(0, (Math.log2(speed) + 2) / 4))
      const arcColor = '#16a085'
      ctx.beginPath(); ctx.arc(acx, acy, r, startA, startA + sweep)
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke()
      if (pct > 0) {
        ctx.beginPath(); ctx.arc(acx, acy, r, startA, startA + pct * sweep)
        ctx.strokeStyle = arcColor; ctx.lineWidth = 7; ctx.stroke()
        ctx.beginPath(); ctx.arc(acx, acy, r, startA, startA + pct * sweep)
        ctx.strokeStyle = arcColor; ctx.lineWidth = 12; ctx.globalAlpha = 0.2; ctx.stroke()
        ctx.globalAlpha = 1
      }
      const spdStr = speed === 1 ? '×1' : speed < 1 ? `÷${+(1/speed).toFixed(2)}` : `×${speed}`
      ctx.font = `bold ${spdStr.length > 3 ? 13 : 16}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = arcColor; ctx.fillText(spdStr, acx, acy)
      ctx.font = '8px monospace'; ctx.fillStyle = '#16a085'
      ctx.textBaseline = 'top'; ctx.fillText('SPD', acx, acy + r + 4)
    } else {
      const pct = Math.min(1, intensity / 200)
      ctx.beginPath(); ctx.arc(acx, acy, r, startA, startA + sweep)
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke()
      if (pct > 0) {
        ctx.beginPath(); ctx.arc(acx, acy, r, startA, startA + pct * sweep)
        ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.stroke()
        ctx.beginPath(); ctx.arc(acx, acy, r, startA, startA + pct * sweep)
        ctx.strokeStyle = color; ctx.lineWidth = 12; ctx.globalAlpha = 0.15; ctx.stroke()
        ctx.globalAlpha = 1
      }
      ctx.font = `bold ${intensity >= 100 ? 18 : 22}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = anyConn ? color : '#333'
      ctx.fillText(anyConn ? `${intensity}` : '—', acx, acy)
      ctx.font = '8px monospace'; ctx.fillStyle = '#444'
      ctx.textBaseline = 'top'; ctx.fillText('%', acx, acy + r + 4)
    }

    // Waveform name (right side) — same layout as single mode
    if (anyConn) {
      const wfDisplay = resolveWfName(waveform, items)
      const fontSize = wfDisplay.length > 8 ? 11 : 13
      ctx.font = `bold ${fontSize}px monospace`
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
      ctx.fillStyle = isSelected ? '#fff' : '#888'
      if (wfDisplay.length > 10) {
        const mid = Math.floor(wfDisplay.length / 2)
        const sp = wfDisplay.lastIndexOf(' ', mid) > 0 ? wfDisplay.lastIndexOf(' ', mid) : mid
        ctx.fillText(wfDisplay.slice(0, sp), ox + 194, acy - 8)
        ctx.fillText(wfDisplay.slice(sp + 1 || sp), ox + 194, acy + 8)
      } else {
        ctx.fillText(wfDisplay, ox + 194, acy)
      }
    }
  }

  // Navigation arrows at outer edges
  if (hasPrev) {
    ctx.font = 'bold 12px monospace'; ctx.textBaseline = 'middle'
    ctx.fillStyle = '#2ecc71'; ctx.textAlign = 'left'
    ctx.fillText('◀', 4, H / 2)
  }
  if (hasNext) {
    ctx.font = 'bold 12px monospace'; ctx.textBaseline = 'middle'
    ctx.fillStyle = '#2ecc71'; ctx.textAlign = 'right'
    ctx.fillText('▶', W - 4, H / 2)
  }

  return rgba(canvas)
}

// ─── Macro page LCD (800×100) ─────────────────────────────────────────────
const BLOCK_META = {
  start:      { icon:'▶', label:'START',      color:'#4ade80' },
  end:        { icon:'■', label:'END',        color:'#f87171' },
  stop_all:   { icon:'⛔', label:'STOP ALL',  color:'#ef4444' },
  delay:      { icon:'⏱', label:'DELAY',      color:'#60a5fa' },
  ramp:       { icon:'↗', label:'RAMP',       color:'#c084fc' },
  wait_eom:   { icon:'◈', label:'WAIT EOM',   color:'#f97316' },
  wait_manual:{ icon:'⏸', label:'WAITING',   color:'#fbbf24' },
  if_else:    { icon:'⋈', label:'IF / ELSE', color:'#e879f9' },
  loop:       { icon:'↺', label:'LOOP',       color:'#818cf8' },
  run_macro:  { icon:'▷', label:'SUB MACRO', color:'#34d399' },
  dev:        { icon:'⚡', label:'SET DEVICE',color:'#ef4444' },
  hue_set:    { icon:'☀', label:'SET HUE',   color:'#a78bfa' },
  hue_ramp:   { icon:'☀', label:'HUE RAMP',  color:'#a78bfa' },
}

function blockSummaryForLcd(type, cfg, macros) {
  if (!cfg) return ''
  switch (type) {
    case 'delay':       return `${cfg.dur ?? 10}s`
    case 'ramp':        return `${cfg.from ?? 0} → ${cfg.to ?? 100}`
    case 'wait_eom':    return `${(cfg.cond||'').includes('>') ? '>' : '<'} ${cfg.thr ?? 70}%`
    case 'wait_manual': return (cfg.prompt || '').slice(0, 22)
    case 'if_else':     return `${(cfg.cond||'').includes('>') ? '>' : '<'} ${cfg.thr ?? 80}%`
    case 'loop':        return cfg.mode === 'Repeat N times' ? `×${cfg.count ?? 3}` : `EOM ${(cfg.mode||'').includes('>') ? '>' : '<'} ${cfg.thr ?? 75}%`
    case 'run_macro':   { const m = (macros||[]).find(x=>x.id===cfg.macroId); return m ? m.name.slice(0,16) : '?' }
    case 'dev':         return cfg.waveform ? cfg.waveform.slice(0,14) : ''
    case 'hue_set':     { const p=(cfg.hueTarget||'').split(':'); return p[2]?`${p[1]}:${p[2]}`.slice(0,16):'' }
    case 'hue_ramp':    return `${cfg.from??20}%→${cfg.to??100}% / ${cfg.dur||30}s`
    default:            return ''
  }
}

function renderMacroLcd(macros, viewOffset, runningId, waitingId, currentBlock, tick, countdown, ramp) {
  const W = 800, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  const isWaiting = !!waitingId
  const isRunning = !!runningId && !isWaiting
  const flashOn   = tick % 2 === 0

  if (isWaiting) {
    if (flashOn) {
      ctx.fillStyle = '#1a0900'; ctx.fillRect(0, 0, W, H)
      ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, W-2, H-2)
      ctx.font = 'bold 17px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = '#fdba74'; ctx.fillText('⏸  TAP SCREEN TO CONTINUE', W/2, 34)
      const prompt = currentBlock?.config?.prompt || (macros.find(m=>m.id===waitingId)?.name || '')
      if (prompt) {
        ctx.font = '11px monospace'; ctx.fillStyle = '#f9731699'
        ctx.fillText(prompt.slice(0, 40), W/2, 66)
      }
    } else {
      ctx.fillStyle = '#0a0500'; ctx.fillRect(0, 0, W, H)
      ctx.strokeStyle = '#f9731633'; ctx.lineWidth = 1; ctx.strokeRect(1, 1, W-2, H-2)
    }
    return rgba(canvas)
  }

  if (isRunning && currentBlock) {
    const bi = BLOCK_META[currentBlock.type] || { icon:'?', label:(currentBlock.type||'').toUpperCase(), color:'#888' }
    const summary = blockSummaryForLcd(currentBlock.type, currentBlock.config, macros)

    // Green-bordered block card (left 475px) — mirrors web UI green glow box
    roundRect(ctx, 8, 10, 470, 80, 6)
    ctx.fillStyle = '#0a1a0a'; ctx.fill()
    ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 1.5; ctx.stroke()

    // Soft pulsing glow — animates with tick
    const glowA = 0.07 + 0.05 * Math.sin(tick * 0.9)
    roundRect(ctx, 8, 10, 470, 80, 6)
    ctx.strokeStyle = `rgba(74,222,128,${glowA})`; ctx.lineWidth = 9; ctx.stroke()

    // Block icon
    ctx.font = 'bold 26px sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = bi.color
    ctx.fillText(bi.icon, 46, 50)

    // Block type label
    ctx.font = 'bold 13px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.fillStyle = bi.color; ctx.fillText(bi.label, 76, 18)

    // Hue ramp animation — special display
    if (currentBlock.type === 'hue_ramp' && ramp) {
      const { value, from, to, elapsed, total } = ramp
      const pct = Math.max(0, Math.min(1, (value - Math.min(from,to)) / (Math.max(from,to) - Math.min(from,to) || 1)))
      const isUp = to >= from

      // Current brightness % (large)
      const valStr = `${Math.round(value)}%`
      ctx.font = `bold ${valStr.length > 4 ? 22 : 28}px monospace`
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = bi.color
      ctx.fillText(valStr, 76, 42)

      // From → To
      ctx.font = '9px monospace'; ctx.fillStyle = '#555'
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      ctx.fillText(`${from}% → ${to}%`, 76, 22)

      // Elapsed / total time
      ctx.font = '9px monospace'; ctx.fillStyle = '#444'
      ctx.textBaseline = 'bottom'; ctx.fillText(`${elapsed.toFixed(1)}s / ${total}s`, 76, 84)

      // Brightness bar (cyan/blue gradient, Hue colours)
      const barX = 20, barY = 74, barW = 448, barH = 7
      ctx.fillStyle = '#071520'; ctx.fillRect(barX, barY, barW, barH)
      if (pct > 0) {
        const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0)
        grad.addColorStop(0, isUp ? '#1a3a5c' : '#4fc3f7')
        grad.addColorStop(1, isUp ? '#4fc3f7' : '#1a3a5c')
        ctx.fillStyle = grad
        ctx.fillRect(barX, barY, Math.round(barW * pct), barH)
      }
      const markerX = barX + Math.round(barW * pct)
      ctx.fillStyle = '#a78bfa'; ctx.fillRect(Math.max(barX, markerX - 1), barY - 1, 3, barH + 2)

    // Coyote ramp animation — special display
    } else if (currentBlock.type === 'ramp' && ramp) {
      const { value, from, to, elapsed, total } = ramp
      const pct = Math.max(0, Math.min(1, (value - Math.min(from,to)) / (Math.max(from,to) - Math.min(from,to) || 1)))
      const isUp = to >= from

      // Current value (large)
      const valStr = String(Math.round(value))
      ctx.font = `bold ${valStr.length > 3 ? 22 : 28}px monospace`
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = bi.color
      ctx.fillText(valStr, 76, 42)

      // From → To
      ctx.font = '9px monospace'; ctx.fillStyle = '#555'
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      ctx.fillText(`${from} → ${to}`, 76, 22)

      // Elapsed / total time
      const remStr = `${elapsed.toFixed(1)}s / ${total}s`
      ctx.font = '9px monospace'; ctx.fillStyle = '#444'
      ctx.textBaseline = 'bottom'; ctx.fillText(remStr, 76, 84)

      // Value progress bar (shows position between from and to)
      const barX = 20, barY = 74, barW = 448, barH = 7
      ctx.fillStyle = '#0d1020'; ctx.fillRect(barX, barY, barW, barH)
      if (pct > 0) {
        const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0)
        grad.addColorStop(0, isUp ? '#1c0e2e' : '#c084fc')
        grad.addColorStop(1, isUp ? '#c084fc' : '#1c0e2e')
        ctx.fillStyle = grad
        ctx.fillRect(barX, barY, Math.round(barW * pct), barH)
      }
      // Moving position marker
      const markerX = barX + Math.round(barW * pct)
      ctx.fillStyle = '#e0c0ff'; ctx.fillRect(Math.max(barX, markerX - 1), barY - 1, 3, barH + 2)

    // Delay countdown — special display
    } else if (currentBlock.type === 'delay' && countdown) {
      const { remaining, total } = countdown
      const pct = Math.max(0, Math.min(1, remaining / total))

      // Remaining time (large)
      const remStr = remaining >= 10 ? `${Math.ceil(remaining)}s` : `${remaining.toFixed(1)}s`
      ctx.font = `bold ${remStr.length > 4 ? 22 : 28}px monospace`
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = bi.color
      ctx.fillText(remStr, 76, 46)

      // Total
      ctx.font = '9px monospace'; ctx.fillStyle = '#444'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(`/ ${total}s`, 76 + (remStr.length > 4 ? 70 : 82), 50)

      // Progress bar across bottom of card
      const barX = 20, barY = 76, barW = 448, barH = 7
      ctx.fillStyle = '#0d260d'; ctx.fillRect(barX, barY, barW, barH)
      if (pct > 0) {
        const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0)
        grad.addColorStop(0, '#4ade80'); grad.addColorStop(1, '#16a085')
        ctx.fillStyle = grad
        ctx.fillRect(barX, barY, Math.round(barW * pct), barH)
      }
    } else {
      // Normal summary
      if (summary) {
        ctx.font = '11px monospace'; ctx.fillStyle = '#888'
        ctx.textBaseline = 'top'; ctx.fillText(summary, 76, 38)
      }
    }

    // Tag
    ctx.font = '8px monospace'; ctx.fillStyle = '#4ade8055'
    ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillText('NOW RUNNING', 472, 14)

    // Divider
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(494, 10); ctx.lineTo(494, 90); ctx.stroke()

    // Right side: macro info
    const runMacro = macros.find(m => m.id === runningId)
    const dotBright = tick % 3 < 2
    ctx.beginPath(); ctx.arc(512, 28, 4, 0, Math.PI*2)
    ctx.fillStyle = dotBright ? '#4ade80' : '#1a4a1a'; ctx.fill()
    ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillStyle = '#4ade80'; ctx.fillText('RUNNING', 524, 28)

    if (runMacro) {
      const name = runMacro.name.length > 18 ? runMacro.name.slice(0,17)+'…' : runMacro.name
      ctx.font = `bold ${name.length > 14 ? 11 : 13}px monospace`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = '#e0e0e0'; ctx.fillText(name, 646, 55)
    }

    ctx.font = '8px monospace'; ctx.fillStyle = '#2a2a2a'
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('PRESS KNOB TO STOP', 646, 92)
    return rgba(canvas)
  }

  // Idle: 4 columns, one per visible macro
  for (let i = 0; i < 4; i++) {
    const m = macros[viewOffset + i]
    const x = i * 200
    if (i > 0) {
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, H-8); ctx.stroke()
    }
    if (!m) {
      ctx.font = '9px monospace'; ctx.fillStyle = '#1a1a1a'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('—', x+100, H/2)
      continue
    }
    const isRun  = m.id === runningId
    const isWait = m.id === waitingId
    ctx.beginPath(); ctx.arc(x+14, 20, 4, 0, Math.PI*2)
    ctx.fillStyle = isRun ? '#4ade80' : isWait ? '#f97316' : '#252525'; ctx.fill()
    const name = m.name.length > 13 ? m.name.slice(0,12)+'…' : m.name
    ctx.font = `bold ${name.length > 10 ? 10 : 12}px monospace`
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillStyle = isRun ? '#4ade80' : isWait ? '#fdba74' : '#888'
    ctx.fillText(name, x+24, 20)
    ctx.font = '9px monospace'; ctx.fillStyle = isRun ? '#4ade8066' : isWait ? '#f9731666' : '#2a2a2a'
    ctx.textBaseline = 'top'; ctx.fillText(isRun ? 'RUNNING' : isWait ? 'WAITING' : 'PRESS KNOB TO RUN', x+10, 36)
    const bc = (m.blocks||[]).length
    ctx.font = '8px monospace'; ctx.fillStyle = '#2a2a2a'
    ctx.textBaseline = 'bottom'; ctx.fillText(`${bc} block${bc!==1?'s':''}`, x+10, H-6)
  }
  if (viewOffset > 0) {
    ctx.font = 'bold 12px monospace'; ctx.fillStyle = '#2ecc71'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('◀', 4, H/2)
  }
  if (viewOffset + 4 < macros.length) {
    ctx.font = 'bold 12px monospace'; ctx.fillStyle = '#2ecc71'
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText('▶', W-4, H/2)
  }
  return rgba(canvas)
}

// ─── Hue scenes LCD strip (800×100) ──────────────────────────────────────
function renderHueScenesLcd(hueDev, sceneOffset) {
  const W = 800, H = 100
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#060606'; ctx.fillRect(0, 0, W, H)

  const selectedIds = hueDev?.selectedScenes || []
  const allScenes = Object.entries(hueDev?._scenes || {}).filter(([id]) => selectedIds.includes(id))

  if (!allScenes.length) {
    ctx.font = '11px monospace'; ctx.fillStyle = '#333'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('No scenes configured — use Configure in the app', W/2, H/2)
    return rgba(canvas)
  }

  const visibleScenes = allScenes.slice(sceneOffset, sceneOffset + 4)
  const hasPrev = sceneOffset > 0
  const hasNext = sceneOffset + 4 < allScenes.length

  visibleScenes.forEach(([id, sc], i) => {
    const grpId = sc.group
    const grp = grpId ? (hueDev?._groups || {})[grpId] : null
    const on = grpId ? (hueDev?._activeSceneByGroup?.[grpId] === id) : false
    const bri = grp ? Math.round((grp.action?.bri || 254) * 100 / 254) : 100
    const ox = i * 200

    if (i > 0) {
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(ox, 6); ctx.lineTo(ox, H - 6); ctx.stroke()
    }

    if (on) { ctx.fillStyle = '#071520'; ctx.fillRect(ox, 0, 200, H) }

    // On/off dot
    ctx.beginPath(); ctx.arc(ox + 14, 20, 5, 0, Math.PI * 2)
    ctx.fillStyle = on ? '#4fc3f7' : '#555'; ctx.fill()

    // Scene name
    const name = sc.name || id
    const trimmed = name.length > 14 ? name.slice(0, 13) + '…' : name
    ctx.font = `bold ${trimmed.length > 10 ? 10 : 12}px monospace`
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillStyle = '#e0e0e0'
    ctx.fillText(trimmed, ox + 26, 20)

    // Brightness value
    ctx.font = '10px monospace'; ctx.fillStyle = on ? '#4fc3f7' : '#888'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(on ? `${bri}%` : 'OFF', ox + 14, 44)

    // Brightness bar
    const bx = ox + 14, by = 58, bw = 172, bh = 6
    ctx.fillStyle = '#111'; ctx.fillRect(bx, by, bw, bh)
    if (on && bri > 0) {
      const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0)
      grad.addColorStop(0, '#1a4a60'); grad.addColorStop(1, '#4fc3f7')
      ctx.fillStyle = grad; ctx.fillRect(bx, by, Math.round(bw * bri / 100), bh)
    }

    // Tap hint
    ctx.font = '7px monospace'; ctx.fillStyle = '#222'
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillText('TAP TO TOGGLE', ox + 100, H - 3)
  })

  if (hasPrev) {
    ctx.font = 'bold 14px monospace'; ctx.fillStyle = '#4fc3f7'
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('◀', 4, H/2)
  }
  if (hasNext) {
    ctx.font = 'bold 14px monospace'; ctx.fillStyle = '#4fc3f7'
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText('▶', W - 4, H/2)
  }

  return rgba(canvas)
}

// ─── Page definitions ─────────────────────────────────────────────────────
function getActiveDeviceTypes(devices) {
  return DEVICE_TYPE_ORDER.filter(t => Object.values(devices).some(d => d.type === t))
}

function getHomeKeys(devices, devicePageOffset) {
  const activeTypes = getActiveDeviceTypes(devices)
  const visibleTypes = activeTypes.slice(devicePageOffset, devicePageOffset + 4)
  const hasScroll = activeTypes.length > 4
  const curPage = Math.floor(devicePageOffset / 4) + 1
  const totalPages = Math.ceil(activeTypes.length / 4)

  const bottomKeys = Array.from({ length: 4 }, (_, i) => {
    const type = visibleTypes[i]
    if (!type) return { icon:'', label:'', color:'dim' }
    const cfg = DEVICE_DECK_CONFIG[type]
    return { deviceKey: cfg.deviceKey || null, icon: cfg.icon || '', label: cfg.label, color: cfg.color }
  })

  return [
    { houseIcon:true, label:'Home',    color:'blue', active:true },
    { icon:'▷',       label:'Macros',  color:'teal' },
    hasScroll
      ? { icon:'▶', label:`${curPage}/${totalPages}`, color:'blue' }
      : { icon:'',  label:'',                         color:'dim'  },
    { stopSign:true,  label:'Stop All', color:'red' },
    ...bottomKeys,
  ]
}

function getEomKeys(eomDev) {
  const mode    = eomDev?._mode        || 'manual'
  const denials = eomDev?._denialCount || 0
  return [
    { houseIcon:true,  label:'Home',    color:'blue' },
    { icon:'',         label:'',        color:'dim'  },
    { icon:'',         label:'',        color:'dim'  },
    { stopSign:true,   label:'Stop',    color:'red'  },
    { icon:'▶',        label:'Auto',    color:'green',  active: mode==='automatic' },
    { icon:'||',       label:'Manual',  color:'teal',   active: mode==='manual'    },
    { stopSign:true,   label:'Stop Motor', color:'red' },
    { icon:'', label:'DENIED', color: denials > 0 ? 'red' : 'dim', value: denials > 0 ? denials : 0, valueColor: denials > 0 ? '#e74c3c' : '#333', valueLarge: true },
  ]
}

function getNimbleKeys(dev, paused=false, tick=0) {
  const airIn    = dev?.airIn      || false
  const airOut   = dev?.airOut     || false
  const running  = dev?.oscillating || false
  const flashOn  = paused && (tick % 2 === 0)
  const runKey   = running
    ? { icon:'⏹', label:'Stop',   color:'red',   active:true }
    : paused
      ? { icon:'▶', label:'Resume', color: flashOn ? 'green' : 'dim', active: flashOn }
      : { icon:'▶', label:'Run',    color:'green' }
  return [
    { houseIcon:true, label:'Home',    color:'blue' },
    { icon:'',        label:'',        color:'dim'  },
    { icon:'',        label:'',        color:'dim'  },
    { stopSign:true,  label:'E-Stop',  color:'red'  },
    { icon:'▲',       label:'Air In',  color: airIn  ? 'green' : 'teal', active: airIn  },
    { icon:'▼',       label:'Air Out', color: airOut ? 'green' : 'teal', active: airOut },
    runKey,
    { icon:'',        label:'',        color:'dim'  },
  ]
}

// ─── E-Stim 2B mode definitions ──────────────────────────────────────────
const ESTIM_MODES = [
  'Pulse','Bounce','Continuous','A Split','B Split','Wave','Waterfall',
  'Squeeze','Milk','Throb','Thrust','Random','Step','Training',
  'Microphone','Stereo','Tickle','Pwr Level','Mic Level','A&B Link'
]

// ─── Draw a 120×120 estim mode button ─────────────────────────────────────
// Wave shape types for each estim mode
const ESTIM_WAVE_TYPE = {
  'Pulse':'square', 'Bounce':'sine', 'Continuous':'flat', 'A Split':'split',
  'B Split':'split', 'Wave':'sine', 'Waterfall':'ramp', 'Squeeze':'squeeze',
  'Milk':'pulse3', 'Throb':'throb', 'Thrust':'pulse3', 'Random':'random',
  'Step':'step', 'Training':'ramp', 'Microphone':'mic', 'Stereo':'stereo',
  'Tickle':'dots', 'Pwr Level':'flat', 'Mic Level':'flat', 'A&B Link':'chain'
}

function drawEstimWave(ctx, type, x, y, w, h, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.beginPath()
  const mid = y + h / 2
  switch (type) {
    case 'square': // on-off pulse
      [0,.25,.25,.75,.75,1].forEach((t,i) => {
        const px = x + t*w, py = mid + (i%2===0?-h*.4:h*.4)
        i===0 ? ctx.moveTo(px,py) : ctx.lineTo(px,py)
      }); break
    case 'sine':
      for (let i=0;i<=w;i++) ctx[i===0?'moveTo':'lineTo'](x+i, mid - Math.sin(i/w*Math.PI*3)*h*.42); break
    case 'flat':
      ctx.moveTo(x, mid); ctx.lineTo(x+w, mid); break
    case 'split': // two levels alternating
      for (let i=0;i<4;i++) {
        const lx=x+i*w/4, ht=i%2===0?-h*.35:h*.35
        i===0?ctx.moveTo(lx,mid+ht):ctx.lineTo(lx,mid+ht)
        ctx.lineTo(lx+w/4,mid+ht)
      }; break
    case 'ramp': // sawtooth
      for (let i=0;i<3;i++) { const lx=x+i*w/3; ctx[i===0?'moveTo':'lineTo'](lx,mid+h*.4); ctx.lineTo(lx+w/3,mid-h*.4) }; break
    case 'squeeze': // sine getting narrower
      for (let i=0;i<=w;i++) { const t=i/w; ctx[i===0?'moveTo':'lineTo'](x+i, mid - Math.sin(t*Math.PI*4)*h*.42*(1-t*.5)) }; break
    case 'pulse3': // three bursts
      [0,.1,.2,.35,.45,.55,.7,.8,.9,1].forEach((t,i) => {
        const px=x+t*w, on=i%2===0; ctx[t===0?'moveTo':'lineTo'](px, mid+(on?-h*.38:h*.38))
      }); break
    case 'throb': // heartbeat-ish
      for (let i=0;i<=w;i++) { const t=i/w; const v=Math.pow(Math.abs(Math.sin(t*Math.PI*2)),3); ctx[i===0?'moveTo':'lineTo'](x+i, mid-v*h*.44) }; break
    case 'random':
      ctx.moveTo(x, mid); for(let i=1;i<=8;i++) ctx.lineTo(x+i*w/8, mid+(Math.sin(i*2.7)*h*.4)); break
    case 'step':
      for (let i=0;i<4;i++) { const lx=x+i*w/4, lh=mid-i*h*.28; ctx[i===0?'moveTo':'lineTo'](lx,lh); ctx.lineTo(lx+w/4,lh) }; break
    case 'mic':
      ctx.arc(x+w/2, mid, h*.3, Math.PI, 0); ctx.moveTo(x+w*.25, mid+h*.1); ctx.lineTo(x+w*.25, mid+h*.35); ctx.lineTo(x+w*.75, mid+h*.35); ctx.lineTo(x+w*.75, mid+h*.1); break
    case 'stereo':
      ctx.moveTo(x,mid-h*.3); for(let i=0;i<=w/2-4;i++) ctx.lineTo(x+i,mid-Math.abs(Math.sin(i/8))*h*.35)
      ctx.moveTo(x+w/2+4,mid+h*.3); for(let i=0;i<=w/2-4;i++) ctx.lineTo(x+w/2+4+i,mid+Math.abs(Math.sin(i/8))*h*.35); break
    case 'dots':
      ctx.stroke(); ctx.beginPath()
      for(let i=0;i<5;i++) { ctx.arc(x+w/10+i*w/5, mid, 3, 0, Math.PI*2); ctx.closePath() }
      ctx.fillStyle=color; ctx.fill(); return
    case 'chain':
      for(let i=0;i<3;i++) { ctx.moveTo(x+i*w/3+4,mid); ctx.arc(x+i*w/3+w/6,mid,h*.3,0,Math.PI*2) }; break
    default:
      for (let i=0;i<=w;i++) ctx[i===0?'moveTo':'lineTo'](x+i, mid-Math.sin(i/w*Math.PI*2)*h*.4); break
  }
  ctx.stroke()
}

function renderEstimModeKey(name, active) {
  const S = 120
  const canvas = createCanvas(S, S)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000'; roundRect(ctx, 0, 0, S, S, 10); ctx.fill()
  ctx.strokeStyle = active ? '#e74c3c' : '#444'
  ctx.lineWidth = active ? 2.5 : 1
  roundRect(ctx, 1, 1, S-2, S-2, 10); ctx.stroke()
  if (active) {
    ctx.save(); ctx.shadowColor='#e74c3c'; ctx.shadowBlur=12
    ctx.strokeStyle='#e74c3caa'; ctx.lineWidth=3
    roundRect(ctx, 1, 1, S-2, S-2, 10); ctx.stroke(); ctx.restore()
  }
  // Wave preview
  const waveType = ESTIM_WAVE_TYPE[name] || 'sine'
  const waveColor = active ? '#e74c3c' : '#555'
  drawEstimWave(ctx, waveType, 10, 8, S-20, 42, waveColor)
  // Mode name — bigger text, wrap at space
  const words = name.split(' ')
  const fontSize = name.length > 10 ? 11 : name.length > 7 ? 13 : 15
  ctx.font = `bold ${fontSize}px sans-serif`
  ctx.fillStyle = active ? '#fff' : '#ccc'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  if (words.length >= 2) {
    const mid = Math.ceil(words.length / 2)
    ctx.fillText(words.slice(0, mid).join(' '), S/2, S*0.67)
    ctx.fillText(words.slice(mid).join(' '), S/2, S*0.84)
  } else {
    ctx.fillText(name, S/2, S*0.75)
  }
  return rgba(canvas)
}

// ─── E-Stim top row keys ──────────────────────────────────────────────────
function getEstimTopKeys(dev, modeOffset) {
  const totalPages = Math.ceil(ESTIM_MODES.length / 4)
  const curPage    = Math.floor(modeOffset / 4) + 1
  const pwrMode    = dev?.powerMode ?? 'L'
  const joined     = dev?.joined ?? false
  return [
    { houseIcon:true, label:'Home', color:'blue' },
    pwrMode==='H'
      ? { value:'H', valueLarge:true, valueColor:'#fff', color:'red', active:true, bg:'#6e0000' }
      : { value:'L', valueLarge:true, valueColor:'#16a085', color:'teal' },
    { icon:'▶', label:`${curPage}/${totalPages}`, color:'blue' },
    { stopSign:true, label:'Stop All', color:'red' },
  ]
}

// getCoyoteTopKeys — top row: home, group-toggle, cycle, stop
function getCoyoteTopKeys(curPage, totalPages, groupMode) {
  return [
    { houseIcon:true, label:'Home',  color:'blue' },
    groupMode
      ? { groupIcon: true, label: 'Group',  color: 'teal', active: true  }
      : { singleIcon: true, label: 'Single', color: 'blue', active: false },
    { icon:'▶',  label:`${curPage}/${totalPages}`, color:'blue' },
    { stopSign:true, label:'Stop All', color:'red' },
  ]
}

// ─── Main controller class ────────────────────────────────────────────────
export class StreamDeckController {
  constructor(devices, deviceBroadcast, groups = [], macroCallbacks = {}) {
    this.devices = devices
    this.broadcast = deviceBroadcast
    this.groups = groups          // array of { id, name, channels:[{deviceId,channel}] } from web UI
    this._macroCallbacks = macroCallbacks  // { run(id), stop(id), resume(id) }
    this._macros = []
    this._macroViewOffset = 0
    this._runningMacroId = null
    this._macroWaitingId = null
    this._macroCurrentBlock = null  // { type, config }
    this._macroCountdown = null     // { remaining, total } during a delay block
    this._macroRamp = null          // { value, from, to, elapsed, total } during a ramp block
    this.deck = null
    this.page = 'home'
    this._waveOffset = 0      // index of first visible waveform item
    this._coyoteItems = []    // all waveform/audio items
    this._selectedChannel = null  // null | 0-3 (single) or 0-1 (group) — LCD-touch for waveform assign
    this._lastSetWaveformId = null  // last explicitly selected waveform id
    this._groupMode = false        // true = encoders broadcast to all devices per group
    this._groupViewOffset = 0     // first group index shown (shown in pairs of 2)
    this._encoderSpeedMode = [false, false, false, false]  // per-encoder: speed mode vs intensity mode
    this._estimModeOffset = 0  // first visible mode index on estim page
    // Per-encoder mode: each toggles between 'power' and its secondary ('feel' or 'rate')
    // enc0: U1 Ch A power ↔ U1 Feel  enc1: U1 Ch B power ↔ U1 Rate
    // enc2: U2 Ch A power ↔ U2 Feel  enc3: U2 Ch B power ↔ U2 Rate
    this._estimEncMode = ['power', 'power', 'power', 'power']
    this._estimSelected = false  // true = unit1 channels highlighted for mode assignment
    this._devicePageOffset = 0
    this._nimblePaused = false
    this._hueSceneOffset = 0
    this._hueKnobTimers = {}
    this._shellyPageOffset = 0
    this._tick = 0
    this._timer = null
    this._ready = false
  }

  async init() {
    const decks = await listStreamDecks()
    if (!decks.length) { console.log('[deck] No Stream Deck found'); return false }
    try {
      this.deck = await openStreamDeck(decks[0].path)
      console.log(`[deck] Opened: ${this.deck.PRODUCT_NAME}`)
    } catch (e) {
      console.error('[deck] Failed to open:', e.message); return false
    }

    await loadDeviceIcons()
    this._coyoteItems = loadCoyoteItems()
    console.log(`[deck] ${this._coyoteItems.length} waveform/audio items loaded`)
    await this.deck.setBrightness(70)
    await this.deck.clearPanel()

    // ── Events ──────────────────────────────────────────────────
    this.deck.on('down', ctrl => {
      if (ctrl.type === 'button')  this._onKey(ctrl.index)
      if (ctrl.type === 'encoder') this._onEncoderPress(ctrl.index)
    })
    this.deck.on('up', ctrl => {
      if (ctrl.type === 'button') this._onKeyUp(ctrl.index)
    })
    this.deck.on('rotate', (ctrl, ticks) => this._onRotate(ctrl.index, ticks))
    this.deck.on('lcdShortPress', (ctrl, pos) => this._onLcdTouch(pos))
    this.deck.on('error', err => console.error('[deck] error:', err.message))

    this._ready = true
    await this.render()

    // Refresh LCD every 500ms for live data; also flash Stop button when nimble is paused
    this._timer = setInterval(() => {
      this._tick++
      this._refreshLcd()
      if (this._nimblePaused) this._renderKeys().catch(()=>{})
    }, 500)

    return true
  }

  // ── Key press handler ──────────────────────────────────────────
  _onKey(idx) {
    console.log(`[deck] key ${idx} on page ${this.page}`)
    switch (this.page) {
      case 'home':    this._homeKey(idx);    break
      case 'eom':     this._eomKey(idx);     break
      case 'coyote':  this._coyoteKey(idx);  break
      case 'estim':   this._estimKey(idx);   break
      case 'macro':   this._macroKey(idx);   break
      case 'hue':     this._hueKey(idx);     break
      case 'shelly':  this._shellyKey(idx);  break
      case 'nimble':  this._nimbleKey(idx);  break
      default: if (idx === 0) this.setPage('home'); break
    }
  }

  _homeKey(idx) {
    if (idx === 1) { this.setPage('macro'); return }
    if (idx === 2) {
      const activeTypes = getActiveDeviceTypes(this.devices)
      if (activeTypes.length > 4) {
        const next = this._devicePageOffset + 4
        this._devicePageOffset = next >= activeTypes.length ? 0 : next
        this._renderKeys()
        this._refreshLcd()
      }
      return
    }
    if (idx === 3) { this._stopAll(); return }
    if (idx >= 4 && idx <= 7) {
      const activeTypes = getActiveDeviceTypes(this.devices)
      const type = activeTypes[this._devicePageOffset + (idx - 4)]
      if (type) this.setPage(DEVICE_DECK_CONFIG[type].page)
      return
    }
  }

  _hueKey(idx) {
    if (idx === 0) { this.setPage('home'); return }
    if (idx === 2) {
      const hue = this._findDev('hue')
      const selectedIds = hue?.selectedScenes || []
      const total = Object.entries(hue?._scenes || {}).filter(([id]) => selectedIds.includes(id)).length
      if (total > 4) {
        const next = this._hueSceneOffset + 4
        this._hueSceneOffset = next >= total ? 0 : next
        this._renderKeys(); this._refreshLcd()
      }
      return
    }
    if (idx === 3) { this._stopAll(); return }
  }

  _getShellyItems() {
    const items = []
    for (const dev of Object.values(this.devices).filter(d => d.type === 'shelly')) {
      for (const [key, state] of Object.entries(dev.components || {})) {
        const [type, idxStr] = key.split(':')
        if (type !== 'switch' && type !== 'light') continue
        const i = parseInt(idxStr)
        const on = type === 'switch' ? state.output === true : (state.output === true || state.ison === true)
        const rawLabel = dev.name || 'Shelly'
        const label = rawLabel.length > 10 ? rawLabel.slice(0, 9) + '…' : rawLabel
        items.push({ devId: dev.id, key, type, idx: i, on, label })
      }
    }
    return items
  }

  _shellyKey(idx) {
    if (idx === 0) { this.setPage('home'); return }
    if (idx === 2) {
      const items = this._getShellyItems()
      if (items.length > 4) {
        const next = this._shellyPageOffset + 4
        this._shellyPageOffset = next >= items.length ? 0 : next
        this._renderKeys()
      }
      return
    }
    if (idx === 3) { this._stopAll(); return }
    if (idx >= 4 && idx <= 7) {
      const items = this._getShellyItems()
      const item = items[this._shellyPageOffset + (idx - 4)]
      if (!item) return
      this._macroCallbacks.shellySet?.({ devId: item.devId, component: item.type, idx: item.idx, params: { on: !item.on } })
      // Optimistically flip state so next render tick reflects it immediately
      const dev = this.devices[item.devId]
      if (dev?.components?.[item.key]) {
        if (item.type === 'switch') dev.components[item.key].output = !item.on
        else { dev.components[item.key].output = !item.on; dev.components[item.key].ison = !item.on }
      }
      this._renderKeys()
    }
  }

  _macroKey(idx) {
    if (idx === 0) { this.setPage('home'); return }
    if (idx === 2) {
      const next = this._macroViewOffset + 4
      this._macroViewOffset = next >= this._macros.length ? 0 : next
      this._renderKeys().catch(()=>{}); this._refreshLcd().catch(()=>{}); return
    }
    if (idx === 3) { this._stopAll(); return }
    if (idx >= 4 && idx <= 7) {
      const m = this._macros[this._macroViewOffset + (idx - 4)]; if (!m) return
      if (this._runningMacroId === m.id || this._macroWaitingId === m.id)
        this._macroCallbacks.stop?.(m.id)
      else
        this._macroCallbacks.run?.(m.id)
    }
  }

  _eomKey(idx) {
    const eom = this._findDev('eom')
    if (idx === 0) { this.setPage('home'); return }
    if (idx === 3) { this._stopAll(); return }
    if (idx === 4 && eom) { eom.setMode('automatic'); this._renderKeys(); return }
    if (idx === 5 && eom) { eom.setMode('manual');    this._renderKeys(); return }
    if (idx === 6 && eom) { eom.setMotor(0); return }
    // idx 7: denial count display — no action
  }

  _coyoteKey(idx) {
    if (idx === 0) { this._selectedChannel = null; this.setPage('home'); return }
    // Key 1: toggle single/group mode
    if (idx === 1) {
      this._groupMode = !this._groupMode
      this._selectedChannel = null   // clear selection on mode switch
      if (this._groupMode) this._groupViewOffset = 0  // reset to first group pair
      this._renderKeys()
      this._refreshLcd()
      return
    }
    // Key 2: cycle forward through waveform pages (looping)
    if (idx === 2) {
      const nextOffset = this._waveOffset + 4
      this._waveOffset = nextOffset >= this._coyoteItems.length ? 0 : nextOffset
      this._renderKeys(); return
    }
    // Key 3: stop all
    if (idx === 3) { this._stopAll(); return }
    // Waveform buttons (4-7): apply waveform to selected channel or group
    if (idx >= 4 && idx <= 7) {
      const item = this._coyoteItems[this._waveOffset + (idx - 4)]
      if (!item) return
      if (this._groupMode) {
        if (this._selectedChannel !== null) {
          // A specific group is selected: apply waveform only to that group
          const group = this.groups[this._groupViewOffset + this._selectedChannel]
          if (group) {
            for (const {deviceId, channel} of group.channels || []) {
              const d = this.devices[deviceId]
              if (d?.setChannel) d.setChannel(channel, { waveform: item.id })
            }
          }
          this._lastSetWaveformId = item.id
          this._selectedChannel = null   // auto-deselect after assignment
        } else {
          // No selection: apply waveform to all 4 visible groups
          for (let gi = 0; gi < 4; gi++) {
            const group = this.groups[this._groupViewOffset + gi]
            if (!group) continue
            for (const {deviceId, channel} of group.channels || []) {
              const d = this.devices[deviceId]
              if (d?.setChannel) d.setChannel(channel, { waveform: item.id })
            }
          }
          this._lastSetWaveformId = item.id
        }
        this._renderKeys(); this._refreshLcd()
      } else if (this._selectedChannel !== null) {
        const { dev, ch } = this._coyoteChannelFor(this._selectedChannel)
        if (dev) dev.setChannel(ch, { intensity: 0, waveform: item.id })
        this._lastSetWaveformId = item.id
        this._selectedChannel = null
        this._renderKeys(); this._renderEncoders()
      } else {
        // No channel selected — apply to all Coyotes
        for (const d of Object.values(this.devices)) {
          if (d.type === 'coyote') {
            d.setChannel('A', { intensity: 0, waveform: item.id })
            d.setChannel('B', { intensity: 0, waveform: item.id })
          }
        }
        this._lastSetWaveformId = item.id
        this._renderKeys(); this._renderEncoders()
      }
      return
    }
  }

  // ── E-Stim key handler ─────────────────────────────────────────
  _estimKey(idx) {
    const dev = this._findDev('estim')
    if (idx === 0) { this.setPage('home'); return }
    // Key 1: toggle High/Low power
    if (idx === 1 && dev?.setPowerMode) {
      dev.setPowerMode((dev.powerMode ?? 'L') === 'H' ? 'L' : 'H')
      this._renderKeys(); this._renderEncoders(); return
    }
    // Key 2: cycle mode pages
    if (idx === 2) {
      const next = this._estimModeOffset + 4
      this._estimModeOffset = next >= ESTIM_MODES.length ? 0 : next
      this._renderKeys(); return
    }
    // Key 3: stop all
    if (idx === 3) { this._stopAll(); return }
    // Keys 4–7: set mode — applies to first estim, clears channel selection
    if (idx >= 4 && idx <= 7 && dev?.setMode) {
      const modeIdx = this._estimModeOffset + (idx - 4)
      if (modeIdx < ESTIM_MODES.length) {
        dev.setMode(modeIdx)
        this._estimSelected = false
        this._renderKeys(); this._renderEncoders()
      }
    }
  }

  _onKeyUp(idx) {
    if (this.page === 'nimble') this._nimbleKeyUp(idx)
  }

  _nimbleKey(idx) {
    const nimble = this._findDev('nimble')
    if (idx === 0) { this._nimblePaused = false; this.setPage('home'); return }
    if (idx === 3) {
      // E-Stop: kill everything
      this._nimblePaused = false
      this._stopAll()
      this._renderKeys()
      return
    }
    if (idx === 4 && nimble) {
      nimble.setAir({ airIn: true, airOut: false })
      this._renderKeys()
      return
    }
    if (idx === 5 && nimble) {
      nimble.setAir({ airOut: true, airIn: false })
      this._renderKeys()
      return
    }
    if (idx === 6 && nimble) {
      if (nimble.oscillating) {
        nimble.setOscillation({ running: false })
        this._nimblePaused = true
      } else {
        nimble.setOscillation({ running: true })
        this._nimblePaused = false
      }
      this._renderKeys()
      return
    }
  }

  _nimbleKeyUp(idx) {
    const nimble = this._findDev('nimble')
    if ((idx === 4 || idx === 5) && nimble) {
      nimble.setAir({ airIn: false, airOut: false })
      this._renderKeys()
    }
  }

  // ── Encoder rotation ───────────────────────────────────────────
  _onRotate(idx, ticks) {
    console.log(`[deck] encoder ${idx} ticks ${ticks} on page ${this.page}`)
    switch (this.page) {
      case 'eom':    this._eomRotate(idx, ticks);    break
      case 'coyote': this._coyoteRotate(idx, ticks); break
      case 'estim':  this._estimRotate(idx, ticks);  break
      case 'hue':    this._hueRotate(idx, ticks);    break
      case 'nimble': this._nimbleRotate(idx, ticks); break
    }
  }

  _eomRotate(idx, ticks) {
    const eom = this._findDev('eom')
    if (!eom) return
    const cfg = eom._config || {}
    if (idx === 0) {  // Motor Speed 0-100, step 2
      const cur = eom._motorSpeed ?? 0
      eom.setMotor(Math.min(100, Math.max(0, cur + ticks * 2)))
    }
    if (idx === 1) {  // Threshold 0-255, step 5
      const cur = cfg.sensitivity_threshold ?? 128
      eom.setConfig({ sensitivity_threshold: Math.min(255, Math.max(0, cur + ticks * 5)) })
    }
    if (idx === 2) {  // Decay 0-500, step 10
      const cur = cfg.arousal_decay_rate ?? 100
      eom.setConfig({ arousal_decay_rate: Math.min(500, Math.max(0, cur + ticks * 10)) })
    }
    if (idx === 3) {  // Cool off 0-30000ms, step 500
      const cur = cfg.cooldown_delay_ms ?? 1000
      eom.setConfig({ cooldown_delay_ms: Math.min(30000, Math.max(0, cur + ticks * 500)) })
    }
    this._refreshLcd()  // update knob values on LCD immediately
  }

  // Return { dev, ch } for a knob index across up to 2 Coyotes (individual coyote page — by position)
  _coyoteChannelFor(idx) {
    const coyotes = Object.values(this.devices).filter(d => d.type === 'coyote')
    const devIdx = Math.floor(idx / 2)
    const ch = idx % 2 === 0 ? 'A' : 'B'
    return { dev: coyotes[devIdx] || null, ch }
  }

  _coyoteRotate(idx, ticks) {
    if (this._groupMode) {
      // Group mode: each encoder (0-3) → groups[viewOffset + idx], controls ALL channels in that group
      const group = this.groups[this._groupViewOffset + idx]
      if (!group) return
      const allChs = group.channels || []

      if (this._encoderSpeedMode[idx]) {
        // Speed mode: step through speed values for all channels in the group
        const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0]
        let curSpeed = 1
        for (const {deviceId, channel} of allChs) {
          const dev = this.devices[deviceId]
          if (dev?.status === 'connected') { curSpeed = dev.channels?.[channel]?.speed ?? 1; break }
        }
        const si = STEPS.reduce((best, v, i) => Math.abs(v - curSpeed) < Math.abs(STEPS[best] - curSpeed) ? i : best, 0)
        const newSpeed = STEPS[Math.max(0, Math.min(STEPS.length - 1, si + ticks))]
        for (const {deviceId, channel} of allChs) {
          const d = this.devices[deviceId]
          if (d?.setChannel) d.setChannel(channel, { speed: newSpeed })
        }
      } else {
        // Intensity mode: read from first connected channel, write to all
        let cur = 0
        for (const {deviceId, channel} of allChs) {
          const dev = this.devices[deviceId]
          if (dev?.status === 'connected') { cur = dev.channels?.[channel]?.intensity ?? 0; break }
        }
        const newVal = Math.min(200, Math.max(0, cur + ticks * 2))
        for (const {deviceId, channel} of allChs) {
          const d = this.devices[deviceId]
          if (d?.setChannel) d.setChannel(channel, { intensity: newVal })
        }
      }
      this._refreshLcd()
      return
    }

    // Individual mode: control each Coyote channel by position
    const ch = idx % 2 === 0 ? 'A' : 'B'
    const { dev } = this._coyoteChannelFor(idx)
    if (!dev) return
    if (this._encoderSpeedMode[idx]) {
      const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0]
      const cur = dev.channels?.[ch]?.speed ?? 1
      const si = STEPS.reduce((best, v, i) => Math.abs(v - cur) < Math.abs(STEPS[best] - cur) ? i : best, 0)
      const ni = Math.max(0, Math.min(STEPS.length - 1, si + ticks))
      dev.setChannel(ch, { speed: STEPS[ni] })
    } else {
      const cur = dev.channels?.[ch]?.intensity || 0
      dev.setChannel(ch, { intensity: Math.min(200, Math.max(0, cur + ticks * 2)) })
    }
    this._renderEncoders()
  }

  _estimRotate(idx, ticks) {
    const estims = Object.values(this.devices).filter(d => d.type === 'estim')
    // enc 0+1 → unit 1,  enc 2+3 → unit 2
    const dev = estims[Math.floor(idx / 2)] || null
    if (!dev) return
    const ch = idx % 2 === 0 ? 'A' : 'B'
    const mode = this._estimEncMode[idx]
    if (mode === 'feel') {
      if (dev.setFeel) dev.setFeel(Math.min(99, Math.max(0, (dev.feel ?? 50) + ticks)))
    } else if (mode === 'rate') {
      if (dev.setRate) dev.setRate(Math.min(99, Math.max(0, (dev.rate ?? 50) + ticks)))
    } else {
      if (dev.setChannel) dev.setChannel(ch, { power: Math.min(99, Math.max(0, (dev.channels?.[ch]?.power ?? 0) + ticks)) })
    }
    this._renderEncoders()
  }

  _nimbleRotate(idx, ticks) {
    const nimble = this._findDev('nimble')
    if (!nimble) return
    if (idx === 0) {  // Stroke Speed (SPM)
      const spm = Math.round((nimble.oscSpeed ?? 0.5) * 60)
      const newSpm = Math.min(300, Math.max(6, spm + ticks * 5))
      nimble.setOscillation({ speed: newSpm / 60 })
    }
    if (idx === 1) {  // Stroke Depth
      nimble.setOscillation({ depth: Math.min(1000, Math.max(0, (nimble.oscDepth ?? 500) + ticks * 10)) })
    }
    if (idx === 2) {  // Nurture — Vibration Intensity
      nimble.setOscillation({ texture: Math.min(200, Math.max(0, (nimble.nsTexture ?? 0) + ticks * 2)) })
    }
    if (idx === 3) {  // Nature — Vibration Speed
      const newNat = Math.min(50, Math.max(0.5, (nimble.nsNature ?? 20) + ticks * 0.5))
      nimble.setOscillation({ nature: Math.round(newNat * 10) / 10 })
    }
    this._renderEncoders()
  }

  _hueRotate(idx, ticks) {
    const hue = this._findDev('hue')
    if (!hue) return
    const selectedIds = hue.selectedScenes || []
    const allScenes = Object.entries(hue._scenes || {}).filter(([id]) => selectedIds.includes(id))
    const entry = allScenes[this._hueSceneOffset + idx]
    if (!entry) return
    const [, sc] = entry
    const grpId = sc.group
    if (!grpId) return
    const grp = hue._groups?.[grpId]
    const curBri = grp ? Math.round((grp.action?.bri || 254) * 100 / 254) : 100
    const newBri = Math.min(100, Math.max(1, curBri + ticks * 2))
    // Update local state immediately for responsive LCD
    if (hue._groups?.[grpId]) {
      Object.assign(hue._groups[grpId].action || (hue._groups[grpId].action = {}),
        { bri: Math.round(newBri * 254 / 100), on: true })
    }
    this._refreshLcd()
    // Debounce bridge call — only send after 200ms of no movement
    clearTimeout(this._hueKnobTimers[grpId])
    this._hueKnobTimers[grpId] = setTimeout(() => hue.setGroup(grpId, { bri: newBri, on: true }), 200)
  }

  // ── Encoder press ──────────────────────────────────────────────
  _onEncoderPress(idx) {
    if (this.page === 'macro') {
      const m = this._macros[this._macroViewOffset + idx]; if (!m) return
      if (this._runningMacroId === m.id || this._macroWaitingId === m.id)
        this._macroCallbacks.stop?.(m.id)
      else
        this._macroCallbacks.run?.(m.id)
      return
    }
    if (this.page === 'eom') {
      const eom = this._findDev('eom')
      if (!eom) return
      if (idx === 0) { eom.setMotor(0); this._refreshLcd(); return }
      const defaults = [null,  128,                    100,                 1000              ]
      const keys     = [null,  'sensitivity_threshold', 'arousal_decay_rate', 'cooldown_delay_ms']
      if (keys[idx] !== undefined) { eom.setConfig({ [keys[idx]]: defaults[idx] }); this._refreshLcd() }
      return
    }
    if (this.page === 'coyote') {
      // Toggle intensity ↔ speed mode for this encoder
      this._encoderSpeedMode[idx] = !this._encoderSpeedMode[idx]
      this._refreshLcd()
    }
    if (this.page === 'estim') {
      // Each encoder toggles between power and its secondary function
      const secondary = ['feel', 'rate', 'feel', 'rate']
      this._estimEncMode[idx] = this._estimEncMode[idx] === 'power' ? secondary[idx] : 'power'
      this._renderEncoders()
    }
  }

  // ── LCD touch ──────────────────────────────────────────────────
  _onLcdTouch(pos) {
    if (this.page === 'macro') {
      if (this._macroWaitingId) this._macroCallbacks.resume?.(this._macroWaitingId)
      return
    }
    if (this.page === 'estim') {
      const x = pos?.x ?? 0
      if (x < 400) {
        // Touch over encoders 0 or 1 — toggle A+B channel selection for mode assignment
        this._estimSelected = !this._estimSelected
      } else {
        // Touch over encoders 2 or 3 — toggle A+B link (joined) on first device
        const dev = this._findDev('estim')
        if (dev?.setJoined) dev.setJoined(!dev.joined)
      }
      this._renderEncoders(); this._renderKeys(); return
    }
    if (this.page === 'hue') {
      const hue = this._findDev('hue')
      if (!hue) return
      const selectedIds = hue.selectedScenes || []
      const allScenes = Object.entries(hue._scenes || {}).filter(([id]) => selectedIds.includes(id))
      const x = pos?.x ?? 0
      // Edge scroll
      if (x < 30 && this._hueSceneOffset > 0) {
        this._hueSceneOffset = Math.max(0, this._hueSceneOffset - 4)
        this._renderKeys(); this._refreshLcd(); return
      }
      if (x > 770 && this._hueSceneOffset + 4 < allScenes.length) {
        this._hueSceneOffset += 4
        this._renderKeys(); this._refreshLcd(); return
      }
      // Toggle scene in tapped column
      const visibleScenes = allScenes.slice(this._hueSceneOffset, this._hueSceneOffset + 4)
      const col = Math.min(visibleScenes.length - 1, Math.floor(x / 200))
      const entry = visibleScenes[col]
      if (!entry) return
      const [sceneId, sc] = entry
      const grpId = sc.group
      const isActiveScene = grpId ? hue._activeSceneByGroup?.[grpId] === sceneId : false
      if (isActiveScene && grpId) {
        hue.setGroup(grpId, { on: false })
      } else {
        hue.activateScene(sceneId)
      }
      this._refreshLcd()
      return
    }
    if (this.page !== 'coyote') return

    if (this._groupMode) {
      const x = pos?.x ?? 0
      // Left edge (<30px): scroll to previous batch of 4 groups
      if (x < 30 && this._groupViewOffset > 0) {
        this._groupViewOffset = Math.max(0, this._groupViewOffset - 4)
        this._selectedChannel = null
        this._renderKeys(); this._refreshLcd()
        return
      }
      // Right edge (>770px): scroll to next batch of 4 groups
      if (x > 770 && this._groupViewOffset + 4 < this.groups.length) {
        this._groupViewOffset += 4
        this._selectedChannel = null
        this._renderKeys(); this._refreshLcd()
        return
      }
      // Tap a group column (0-3) to select it for waveform assignment
      const groupCol = Math.min(3, Math.floor(x / 200))  // 0-3
      const targetGroup = this.groups[this._groupViewOffset + groupCol]
      if (targetGroup) {
        // Toggle selection — tapping the already-selected group deselects it
        this._selectedChannel = this._selectedChannel === groupCol ? null : groupCol
        this._renderKeys()   // highlight active waveform for selected group
        this._refreshLcd()   // show selection border on LCD
      }
      return
    }

    // Individual mode: tap to select channel for waveform assignment
    const chIdx = Math.floor((pos?.x ?? 0) / 200)  // 0-3
    this._selectedChannel = this._selectedChannel === chIdx ? null : chIdx
    this._renderKeys()
    this._renderEncoders()
  }

  _stopAll() {
    // Kill any running macro first
    if (this._runningMacroId && this._macroCallbacks?.stop) {
      this._macroCallbacks.stop(this._runningMacroId)
    }
    // Zero all devices
    for (const d of Object.values(this.devices)) {
      if (d.type === 'coyote' && d.setChannel) {
        d.setChannel('A', { intensity:0 })
        d.setChannel('B', { intensity:0 })
      }
      if (d.type === 'estim' && d.stop) d.stop()
      if (d.type === 'eom') d.setConfig?.({ motor: 0 })
      if (d.type === 'nimble' && d.stop) d.stop()
    }
    this._renderEncoders().catch(()=>{})
  }

  // Called by server when macro list changes
  updateMacros(macros) {
    this._macros = macros || []
    if (this._macroViewOffset >= this._macros.length) this._macroViewOffset = 0
    if (this.page === 'macro') { this._renderKeys().catch(()=>{}); this._refreshLcd().catch(()=>{}) }
  }

  // Called by server on macro runtime events
  onMacroEvent(msg) {
    if (!this._ready) return
    switch (msg.type) {
      case 'macro:running':
        this._runningMacroId = msg.id; this._macroWaitingId = null; this._macroCurrentBlock = null; break
      case 'macro:stopped':
        if (this._runningMacroId === msg.id) this._runningMacroId = null
        if (this._macroWaitingId === msg.id) this._macroWaitingId = null
        this._macroCurrentBlock = null
        this._macroCountdown = null
        this._macroRamp = null; break
      case 'macro:step':
        this._macroCurrentBlock = { type: msg.blockType, config: msg.config }
        this._macroCountdown = null
        this._macroRamp = null
        this._macroWaitingId = null; break
      case 'macro:countdown':
        this._macroCountdown = { remaining: msg.remaining, total: msg.total }
        if (this.page === 'macro') { this._refreshLcd().catch(()=>{}); return }
        return
      case 'macro:ramp':
        this._macroRamp = { value: msg.value, from: msg.from, to: msg.to, elapsed: msg.elapsed, total: msg.total }
        if (this.page === 'macro') { this._refreshLcd().catch(()=>{}); return }
        return
      case 'macro:label':
        // Brief label update — just refresh LCD display
        if (this.page === 'macro') { this._refreshLcd().catch(()=>{}); return }
        return
      case 'macro:wait':
        this._macroWaitingId = msg.id
        this._macroCurrentBlock = { type: 'wait_manual', config: { prompt: msg.prompt } }; break
    }
    if (this.page === 'macro') { this._renderKeys().catch(()=>{}); this._refreshLcd().catch(()=>{}) }
  }

  // Called by server when groups are created/updated/deleted via web UI
  updateGroups(groups) {
    this.groups = groups || []
    // Clamp view offset in case a group was deleted
    const maxOffset = Math.max(0, this.groups.length - 1)
    if (this._groupViewOffset > maxOffset) this._groupViewOffset = maxOffset & ~3  // keep multiple of 4
    // Live-update if we're on the coyote page in group mode
    if (this.page === 'coyote' && this._groupMode) {
      this._refreshLcd().catch(() => {})
    }
  }

  // Reload waveform/audio items from disk — called when server broadcasts waveforms:updated
  reloadWaveforms() {
    const prev = this._coyoteItems.length
    this._coyoteItems = loadCoyoteItems()
    console.log(`[deck] waveforms reloaded: ${prev} → ${this._coyoteItems.length} items`)
    // Clamp offset in case items were deleted
    if (this._waveOffset >= this._coyoteItems.length) this._waveOffset = Math.max(0, this._coyoteItems.length - 1)
    if (this.page === 'coyote') this._renderKeys().catch(()=>{})
  }

  // ── Page navigation ────────────────────────────────────────────
  setPage(page) {
    this.page = page
    if (page === 'shelly') {
      this._shellyPageOffset = 0
    }
    if (page === 'hue') {
      this._hueSceneOffset = 0
    } else if (page === 'coyote') {
      this._coyoteItems = loadCoyoteItems()
    } else {
      this._encoderSpeedMode = [false, false, false, false]
    }
    if (page !== 'estim') {
      this._estimEncMode = ['power', 'power', 'power', 'power']
      this._estimSelected = false
    }
    this.render()
  }

  // ── Full render — sequential to avoid concurrent HID writes ───
  async render() {
    if (!this._ready) return
    try { await this._renderKeys() }    catch(e) { console.error('[deck] keys:', e.message) }
    try { await this._renderEncoders() } catch(e) { console.error('[deck] encs:', e.message) }
    try { await this._refreshLcd() }    catch(e) { console.error('[deck] lcd:', e.message) }
  }

  async _renderKeys() {
    if (!this.deck) return

    if (this.page === 'macro') {
      // Top row: Home, blank, Scroll, Stop All
      const total = this._macros.length
      const page  = total ? Math.floor(this._macroViewOffset / 4) + 1 : 1
      const pages = total ? Math.ceil(total / 4) : 1
      const topKeys = [
        { houseIcon:true, label:'Home',   color:'blue' },
        { icon:'',        label:'',       color:'dim'  },
        { icon:'▶', label:`${page}/${pages}`, color:'blue' },
        { stopSign:true,  label:'Stop All',color:'red'  },
      ]
      for (let i = 0; i < 4; i++)
        await this.deck.fillKeyBuffer(i, renderKey(topKeys[i]), { format:'rgba' })
      // Bottom row: 4 macro name keys
      for (let i = 0; i < 4; i++) {
        const m = this._macros[this._macroViewOffset + i]
        const isRun  = m && m.id === this._runningMacroId
        const isWait = m && m.id === this._macroWaitingId
        const name   = m ? (m.name.length > 8 ? m.name.slice(0,7)+'…' : m.name) : ''
        const buf = m
          ? renderKey({ icon: isRun ? '▶' : isWait ? '⏸' : '▷', label: name, color: isRun ? 'green' : isWait ? 'orange' : 'dim', active: isRun || isWait, bg: isRun ? '#0d2010' : isWait ? '#1a0d00' : '#000' })
          : renderKey({ icon:'', label:'', color:'dim' })
        await this.deck.fillKeyBuffer(4 + i, buf, { format:'rgba' })
      }
      return
    }

    if (this.page === 'coyote') {
      // Top row: home, group-toggle, cycle, stop
      const totalPages = Math.ceil(this._coyoteItems.length / 4)
      const curPage = Math.floor(this._waveOffset / 4) + 1
      const topKeys = getCoyoteTopKeys(curPage, totalPages, this._groupMode)
      for (let i = 0; i < 4; i++) {
        await this.deck.fillKeyBuffer(i, renderKey(topKeys[i]), { format:'rgba' })
      }
      // Bottom row: waveform items (4-7)
      // Active = item is used by the selected channel/group (or any channel if none selected)
      const allCoyotes = Object.values(this.devices).filter(d => d.type === 'coyote')
      const activeWaveforms = new Set()
      if (this._selectedChannel !== null) {
        if (this._groupMode) {
          // _selectedChannel is 0-3 (which group column). Find first connected channel in that group.
          const group = this.groups[this._groupViewOffset + this._selectedChannel]
          if (group) {
            for (const {deviceId, channel} of group.channels || []) {
              const dev = this.devices[deviceId]
              if (dev?.status === 'connected' && dev.channels?.[channel]?.waveform) {
                activeWaveforms.add(dev.channels[channel].waveform)
                break
              }
            }
          }
        } else {
          const { dev, ch } = this._coyoteChannelFor(this._selectedChannel)
          if (dev?.channels?.[ch]?.waveform) activeWaveforms.add(dev.channels[ch].waveform)
        }
      } else {
        // Use last explicitly selected waveform — avoids channel B default 'pulse' always appearing active
        if (this._lastSetWaveformId) {
          activeWaveforms.add(this._lastSetWaveformId)
        } else {
          const first = allCoyotes[0]
          if (first?.channels?.A?.waveform) activeWaveforms.add(first.channels.A.waveform)
        }
      }
      for (let i = 0; i < 4; i++) {
        const item = this._coyoteItems[this._waveOffset + i]
        const buf = item
          ? renderWaveformKey(item, activeWaveforms.has(item.id))
          : renderKey({ icon:'', label:'', color:'dim' })
        await this.deck.fillKeyBuffer(4 + i, buf, { format:'rgba' })
      }
      return
    }

    if (this.page === 'estim') {
      const dev = this._findDev('estim')
      // Top row
      const topKeys = getEstimTopKeys(dev, this._estimModeOffset)
      for (let i = 0; i < 4; i++) {
        await this.deck.fillKeyBuffer(i, renderKey(topKeys[i]), { format:'rgba' })
      }
      // Bottom row: 4 modes from current page
      const curMode = dev?.mode ?? 0
      for (let i = 0; i < 4; i++) {
        const modeIdx = this._estimModeOffset + i
        const buf = modeIdx < ESTIM_MODES.length
          ? renderEstimModeKey(ESTIM_MODES[modeIdx], modeIdx === curMode)
          : renderKey({ icon:'', label:'', color:'dim' })
        await this.deck.fillKeyBuffer(4 + i, buf, { format:'rgba' })
      }
      return
    }

    if (this.page === 'shelly') {
      const items = this._getShellyItems()
      const hasScroll = items.length > 4
      const curPage = Math.floor(this._shellyPageOffset / 4) + 1
      const totalPages = Math.ceil(items.length / 4) || 1
      const topKeys = [
        { houseIcon:true, label:'Home',     color:'blue' },
        { icon:'',        label:'',         color:'dim'  },
        hasScroll ? { icon:'▶', label:`${curPage}/${totalPages}`, color:'amber' } : { icon:'', label:'', color:'dim' },
        { stopSign:true,  label:'Stop All', color:'red'  },
      ]
      for (let i = 0; i < 4; i++)
        await this.deck.fillKeyBuffer(i, renderKey(topKeys[i]), { format:'rgba' })
      for (let i = 0; i < 4; i++) {
        const item = items[this._shellyPageOffset + i]
        const buf = item
          ? renderKey({ label: item.label, color: item.on ? 'green' : 'dim', active: item.on, icon: item.on ? '●' : '○', bg: item.on ? '#0a2010' : '#000' })
          : renderKey({ icon:'', label:'', color:'dim' })
        await this.deck.fillKeyBuffer(4 + i, buf, { format:'rgba' })
      }
      return
    }

    if (this.page === 'hue') {
      const hue = this._findDev('hue')
      const selectedIds = hue?.selectedScenes || []
      const total = Object.entries(hue?._scenes || {}).filter(([id]) => selectedIds.includes(id)).length
      const hasScroll = total > 4
      const curPage = Math.floor(this._hueSceneOffset / 4) + 1
      const totalPages = Math.ceil(total / 4) || 1
      const topKeys = [
        { houseIcon:true, label:'Home',     color:'blue' },
        { icon:'',        label:'',         color:'dim'  },
        hasScroll ? { icon:'▶', label:`${curPage}/${totalPages}`, color:'blue' } : { icon:'', label:'', color:'dim' },
        { stopSign:true,  label:'Stop All', color:'red'  },
      ]
      for (let i = 0; i < 4; i++)
        await this.deck.fillKeyBuffer(i, renderKey(topKeys[i]), { format:'rgba' })
      for (let i = 0; i < 4; i++)
        await this.deck.fillKeyBuffer(4 + i, renderKey({ icon:'', label:'', color:'dim' }), { format:'rgba' })
      return
    }

    let keys
    if (this.page === 'home')        keys = getHomeKeys(this.devices, this._devicePageOffset)
    else if (this.page === 'eom')   keys = getEomKeys(this._findDev('eom'))
    else if (this.page === 'nimble') keys = getNimbleKeys(this._findDev('nimble'), this._nimblePaused, this._tick)
    else {
      keys = Array(8).fill({ icon:'', label:'', color:'dim' })
      keys[0] = { houseIcon:true, label:'Home', color:'blue' }
    }

    for (let i = 0; i < 8; i++) {
      const k = keys[i] || { icon:'', label:'', color:'dim' }
      await this.deck.fillKeyBuffer(i, renderKey(k), { format:'rgba' })
    }
  }

  async _renderEncoders() {
    if (!this.deck) return
    let encs
    if (this.page === 'eom' || this.page === 'hue' || this.page === 'nimble') {
      // Full-strip LCD render — handled by _refreshLcd
      return
    } else if (this.page === 'coyote') {
      if (this._groupMode) return  // group mode uses full-strip render via _refreshLcd
      // Individual mode: custom per-channel LCD segments
      const CH_LABELS = ['C1·A', 'C1·B', 'C2·A', 'C2·B']
      const CH_COLORS  = ['#e74c3c', '#e67e22', '#9b59b6', '#3498db']
      for (let i = 0; i < 4; i++) {
        const { dev, ch } = this._coyoteChannelFor(i)
        // In group mode, both channels of a group highlight when that group is selected
        const selected = this._groupMode
          ? this._selectedChannel === Math.floor(i / 2)
          : this._selectedChannel === i
        const buf = renderCoyoteChannelLcd({
          label:     CH_LABELS[i],
          color:     CH_COLORS[i],
          intensity: dev?.channels?.[ch]?.intensity ?? 0,
          waveform:  this._resolveWfName(dev?.channels?.[ch]?.waveform ?? '—'),
          connected: !!dev && dev.status === 'connected',
          selected,
          grouped:   this._groupMode,
          speed:     dev?.channels?.[ch]?.speed ?? 1,
          speedMode: this._encoderSpeedMode[i],
        })
        await this.deck.fillLcdRegion(0, i * 200, 0, buf, { format:'rgba', width:200, height:100 })
      }
      return
    } else if (this.page === 'estim') {
      const estims = Object.values(this.devices).filter(d => d.type === 'estim')
      const dev1 = estims[0], dev2 = estims[1]
      const conn1 = dev1?.status === 'connected'
      const conn2 = dev2?.status === 'connected'
      const sel = this._estimSelected
      // enc 0+1 → unit 1,  enc 2+3 → unit 2
      const devOf   = [dev1, dev1, dev2, dev2]
      const connOf  = [conn1, conn1, conn2, conn2]
      const chOf    = ['A','B','A','B']
      const colors  = ['#e74c3c','#e67e22','#9b59b6','#3498db']
      const unitLbl = ['U1·A','U1·B','U2·A','U2·B']
      const encs = Array.from({length:4}, (_,i) => {
        const dev = devOf[i], conn = connOf[i], ch = chOf[i], color = colors[i]
        const mode = this._estimEncMode[i]
        const joined = dev?.joined ?? false
        const modeName = conn ? (ESTIM_MODES[dev?.mode ?? 0] ?? '') : ''
        if (mode === 'feel') {
          return { label:`U${Math.floor(i/2)+1} FEEL`, value: dev?.feel ?? 50, max:99, unit:'', color, dim:!conn, modeName }
        } else if (mode === 'rate') {
          return { label:`U${Math.floor(i/2)+1} RATE`, value: dev?.rate ?? 50, max:99, unit:'', color, dim:!conn, modeName }
        } else {
          const lbl = joined ? `${unitLbl[i]} ⬡` : unitLbl[i]
          return { label: lbl, value: dev?.channels?.[ch]?.power ?? 0, max:99, unit:'', color, dim:!conn, selected: i < 2 && sel, modeName }
        }
      })
      for (let i = 0; i < 4; i++) {
        const buf = renderEncoderLcd(encs[i])
        await this.deck.fillLcdRegion(0, i * 200, 0, buf, { format:'rgba', width:200, height:100 })
      }
      return
    } else {
      encs = Array(4).fill({ label:'', value:0, max:100, unit:'', color:'#333', dim:true })
    }

    for (let i = 0; i < 4; i++) {
      const e = encs[i] || { dim:true, label:'', value:0, max:100, unit:'' }
      const buf = renderEncoderLcd(e)
      await this.deck.fillLcdRegion(0, i * 200, 0, buf, { format:'rgba', width:200, height:100 })
    }
  }

  async _refreshLcd() {
    if (!this.deck) return
    try {
      if (this.page === 'macro') {
        const buf = renderMacroLcd(this._macros, this._macroViewOffset, this._runningMacroId, this._macroWaitingId, this._macroCurrentBlock, this._tick, this._macroCountdown, this._macroRamp)
        await this.deck.fillLcd(0, buf, { format:'rgba' })
        return
      }
      if (this.page === 'coyote' && this._groupMode) {
        // Group mode: full-strip render showing 2 groups with names
        const buf = renderCoyoteGroupModeLcd(this.groups, this.devices, this._groupViewOffset, this._selectedChannel, this._coyoteItems, this._encoderSpeedMode)
        await this.deck.fillLcd(0, buf, { format:'rgba' })
        return
      }
      if (this.page === 'coyote' || this.page === 'estim') {
        // Individual mode: 4 individual LCD encoder segments
        await this._renderEncoders()
        return
      }
      if (this.page === 'hue') {
        const buf = renderHueScenesLcd(this._findDev('hue'), this._hueSceneOffset)
        await this.deck.fillLcd(0, buf, { format:'rgba' })
        return
      }
      let buf
      if (this.page === 'home')      buf = renderHomeLcd(this.devices, this._devicePageOffset)
      else if (this.page === 'eom')    buf = renderEomLcd(this._findDev('eom'))
      else if (this.page === 'nimble') buf = renderNimbleLcd(this._findDev('nimble'))
      else {
        const W=800, H=100, c=createCanvas(W,H)
        c.getContext('2d').fillStyle='#060606'; c.getContext('2d').fillRect(0,0,W,H)
        buf = rgba(c)
      }
      await this.deck.fillLcd(0, buf, { format:'rgba' })
    } catch (e) {
      // Non-fatal
    }
  }

  // ── Utility ────────────────────────────────────────────────────
  _findDev(type) {
    return Object.values(this.devices).find(d => d.type === type) || null
  }

  // Resolve a waveform ID → display name using the loaded items list
  _resolveWfName(id) {
    return resolveWfName(id, this._coyoteItems)
  }

  // Called by server when device state changes
  onDeviceUpdate() {
    if (!this._ready) return
    this._renderKeys().catch(()=>{})
    this._renderEncoders().catch(()=>{})
    this._refreshLcd().catch(()=>{})
  }

  async close() {
    clearInterval(this._timer)
    if (this.deck) {
      await this.deck.clearPanel().catch(()=>{})
      await this.deck.close().catch(()=>{})
    }
  }
}
