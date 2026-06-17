import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { StreamDeckController } from './streamdeck.js'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, open as fsOpen, read as fsRead, write as fsWrite, close as fsClose } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createBluetooth } from 'node-ble'
import multer from 'multer'
import { exec, execSync, spawn } from 'child_process'
import net from 'net'
import dgram from 'dgram'
import { EventEmitter } from 'events'
EventEmitter.defaultMaxListeners = 100
import { SerialPort } from 'serialport'
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version
import { ReadlineParser } from '@serialport/parser-readline'

// ── EomWS: minimal custom WebSocket client for ESP32 Edge-o-Matic firmware ────
// The EoM firmware sends non-compliant frames (RSV2/RSV3 bits set, non-UTF-8
// text frames). The standard 'ws' library rejects these. This implementation
// ignores all validation and just passes the raw payload up to the caller.
class EomWS extends EventEmitter {
  constructor() { super(); this._sock=null; this._buf=Buffer.alloc(0); this._hs=true; this._hsbuf=Buffer.alloc(0); this.readyState=3 }

  connect(ip, port, delayMs=500) {
    this.readyState=0; this._hs=true; this._hsbuf=Buffer.alloc(0); this._buf=Buffer.alloc(0)
    const sock=net.createConnection(port, ip)
    this._sock=sock
    // Handshake timeout — if no HTTP 101 within 8s, give up
    const hsTimeout=setTimeout(()=>{
      if(this._hs){ this.emit('error',new Error('WS handshake timeout')); sock.destroy() }
    }, 8000)
    sock.once('connect', () => {
      setTimeout(() => {
        const key=randomBytes(16).toString('base64')
        sock.write([`GET / HTTP/1.1`,`Host: ${ip}`,`Upgrade: websocket`,
          `Connection: Upgrade`,`Sec-WebSocket-Key: ${key}`,`Sec-WebSocket-Version: 13`,'',''].join('\r\n'))
      }, delayMs)
    })
    sock.on('data', chunk => {
      if (this._hs) {
        this._hsbuf=Buffer.concat([this._hsbuf, chunk])
        const end=this._hsbuf.indexOf('\r\n\r\n')
        if (end===-1) return
        const hdr=this._hsbuf.slice(0,end).toString()
        const rest=this._hsbuf.slice(end+4)
        this._hs=false
        clearTimeout(hsTimeout)
        if (!hdr.includes('101')) { this.emit('error',new Error('WS upgrade rejected: '+hdr.split('\r\n')[0])); sock.destroy(); return }
        this.readyState=1; this.emit('open')
        if (rest.length>0) this._frames(rest)
      } else { this._frames(chunk) }
    })
    sock.on('error', err => { this.readyState=3; this.emit('error',err) })
    sock.on('close', () => { this.readyState=3; this.emit('close') })
    return this
  }

  _frames(chunk) {
    this._buf=Buffer.concat([this._buf, chunk])
    while (this._buf.length>=2) {
      const b0=this._buf[0], b1=this._buf[1]
      const op=b0&0x0F, masked=(b1&0x80)!==0
      let plen=b1&0x7F, hlen=2
      if (plen===126) { if(this._buf.length<4) break; plen=this._buf.readUInt16BE(2); hlen=4 }
      else if (plen===127) { if(this._buf.length<10) break; plen=this._buf.readUInt32BE(2)*0x100000000+this._buf.readUInt32BE(6); hlen=10 }
      if (masked) hlen+=4
      if (this._buf.length<hlen+plen) break
      let payload=Buffer.alloc(plen); this._buf.copy(payload,0,hlen,hlen+plen)
      if (masked) { const m=this._buf.slice(hlen-4,hlen); for(let i=0;i<plen;i++) payload[i]^=m[i%4] }
      this._buf=this._buf.slice(hlen+plen)
      if (op===0x08) { this.readyState=3; this._sock.destroy(); return }
      if (op===0x09) { this._frame(0x0A,payload) } // pong
      else if (op<=0x02) { this.emit('message',payload,op===0x02) }
      // RSV bits, unknown opcodes: silently ignored
    }
  }

  _frame(op, data) {
    if (this.readyState!==1||!this._sock) return
    const p=Buffer.isBuffer(data)?data:Buffer.from(String(data),'utf8')
    const n=p.length, mask=randomBytes(4)
    const mp=Buffer.alloc(n); for(let i=0;i<n;i++) mp[i]=p[i]^mask[i%4]
    const h=n<126?Buffer.alloc(6):Buffer.alloc(8)
    h[0]=0x80|op
    if (n<126){ h[1]=0x80|n; mask.copy(h,2) }
    else { h[1]=0x80|126; h.writeUInt16BE(n,2); mask.copy(h,4) }
    this._sock.write(Buffer.concat([h,mp]))
  }

  send(data) { this._frame(0x01, data) }
  close() { if(this.readyState===1){this._frame(0x08,Buffer.alloc(0));setTimeout(()=>this._sock?.destroy(),300)} else this._sock?.destroy() }
  terminate() { this._sock?.destroy(); this.readyState=3 }
}
import { randomBytes, createHash } from 'crypto'
import session from 'express-session'
import SessionFileStore from 'session-file-store'
import bcrypt from 'bcryptjs'
const FileStore = SessionFileStore(session)

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH    = join(__dirname, 'config.json')
const WAVEFORMS_PATH = join(__dirname, 'waveforms.json')
const MACROS_PATH    = join(__dirname, 'macros.json')
const AP_FLAG        = '/run/edgecontroller/ap-mode'

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    const d = { boxId: 'sexcontrol1', devices: [], groups: [] }
    writeFileSync(CONFIG_PATH, JSON.stringify(d, null, 2)); return d
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
}
function saveConfig(cfg) { writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)) }
let config = loadConfig()

// ── Auto-generate boxId from Pi serial number if not set ─────────────────────
function getPiSerial() {
  try {
    const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8')
    const match = cpuinfo.match(/Serial\s*:\s*([0-9a-f]+)/i)
    return match ? match[1] : null
  } catch { return null }
}
function serialToId(serial) {
  // SHA-256 the serial, take first 4 hex chars → e.g. "a3f2"
  return createHash('sha256').update(serial).digest('hex').slice(0, 4)
}

// Ensure config defaults
if (!config.sessionSecret) { config.sessionSecret = randomBytes(32).toString('hex'); saveConfig(config) }
if (!config.boxId) {
  const serial = getPiSerial()
  if (serial) {
    config.boxId = serialToId(serial)
    console.log(`[config] auto-generated boxId: ${config.boxId} (from serial ${serial})`)
    saveConfig(config)
  }
}
if (!config.tunnel) config.tunnel = { enabled: false, token: '', hostname: '' }
// Migrate old flat auth → new {admin, user} structure
if (!config.auth) config.auth = { enabled: false }
if (config.auth.username && !config.auth.admin) {
  config.auth.admin = { username: config.auth.username, passwordHash: config.auth.passwordHash || '' }
  delete config.auth.username; delete config.auth.passwordHash
  saveConfig(config)
}
if (!config.auth.admin) config.auth.admin = { username: '', passwordHash: '' }
if (!config.auth.user)  config.auth.user  = { username: '', passwordHash: '' }

function loadWaveforms() {
  if (!existsSync(WAVEFORMS_PATH)) {
    writeFileSync(WAVEFORMS_PATH, JSON.stringify({ custom: [] }, null, 2))
    return { custom: [] }
  }
  const store = JSON.parse(readFileSync(WAVEFORMS_PATH, 'utf8'))
  // Migrate legacy audio frames from {segs:[{f,a},...]} to plain amplitude integers
  let migrated = false
  ;(store.custom || []).forEach(w => {
    if (w.type === 'audio' && Array.isArray(w.frames) && w.frames.length > 0 && typeof w.frames[0] !== 'number') {
      w.frames = w.frames.map(f => f.segs ? f.segs[0].a : 0)
      migrated = true
    }
  })
  if (migrated) writeFileSync(WAVEFORMS_PATH, JSON.stringify(store, null, 2))
  return store
}
function saveWaveforms() { writeFileSync(WAVEFORMS_PATH, JSON.stringify(waveformStore, null, 2)) }
let waveformStore = loadWaveforms()

const BUILTIN_WAVEFORMS = [
  { id:'pulse',     name:'Pulse',     desc:'Rhythmic on/off at 1Hz — classic distinct pulses',          icon:'▐▌' },
  { id:'breathe',   name:'Breathe',   desc:'Smooth sine amplitude envelope — in and out',               icon:'〜' },
  { id:'tidal',     name:'Tidal',     desc:'Alternating 20/40Hz frequencies — shifting feel',            icon:'〰' },
  { id:'wave',      name:'Wave',      desc:'Phase-shifted dual wave — flowing sensation',                icon:'∿' },
  { id:'thud',      name:'Thud',      desc:'Heavy 10Hz impact once per second — deep thumps',           icon:'◉' },
  { id:'flutter',   name:'Flutter',   desc:'Rapid 5Hz alternating bursts — intense staccato',           icon:'※' },
  { id:'ramp',      name:'Ramp',      desc:'Amplitude builds over 2 seconds then resets',               icon:'▲' },
  { id:'heartbeat', name:'Heartbeat', desc:'Lub-dub rhythm — 75bpm cardiac pattern',                    icon:'♥' },
  { id:'steps',     name:'Steps',     desc:'Staircase: 25% → 50% → 75% → 100% every 500ms',            icon:'▬' },
  { id:'buzz',      name:'Buzz',      desc:'Smooth continuous 80Hz — vibration-like sensation',         icon:'≈' },
]

// ── Audio files ──────────────────────────────────────────────────────────────
const AUDIO_DIR = join(__dirname, 'audio')
if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true })

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    filename: (req, file, cb) => cb(null, `af-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`)
  }),
  limits: { fileSize: 150 * 1024 * 1024 }
})

function loadAudioList() {
  try {
    return readdirSync(AUDIO_DIR)
      .filter(f => f.startsWith('af-') && !f.endsWith('.json'))
      .map(f => {
        try { return { id:f, ...JSON.parse(readFileSync(join(AUDIO_DIR,f+'.json'),'utf8')) } }
        catch { return { id:f, name:f } }
      })
  } catch { return [] }
}

// ── Tunnel ───────────────────────────────────────────────────────────────────
let tunnelProc  = null
let tunnelStatus = 'disconnected'

function tunnelStart() {
  if (tunnelProc) return
  const token = (config.tunnel?.token || '').trim()
  if (!token) return
  console.log('[tunnel] starting...')
  tunnelStatus = 'connecting'
  broadcastTunnelStatus()
  tunnelProc = spawn('cloudflared', ['tunnel', 'run', '--token', token], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const onData = buf => {
    const s = buf.toString().trimEnd()
    console.log('[tunnel]', s)
    if (/registered|connected to|INF Connection/i.test(s)) {
      tunnelStatus = 'connected'; broadcastTunnelStatus()
    }
  }
  tunnelProc.stdout.on('data', onData)
  tunnelProc.stderr.on('data', onData)
  tunnelProc.on('exit', code => {
    console.log('[tunnel] exit', code)
    tunnelProc = null
    tunnelStatus = 'disconnected'
    broadcastTunnelStatus()
    // Auto-restart if still enabled
    if (config.tunnel?.enabled) {
      console.log('[tunnel] restarting in 10s...')
      setTimeout(tunnelStart, 10000)
    }
  })
}

function tunnelStop() {
  if (tunnelProc) { tunnelProc.kill('SIGTERM'); tunnelProc = null }
  tunnelStatus = 'disconnected'
  broadcastTunnelStatus()
}

function broadcastTunnelStatus() {
  broadcast({ type: 'tunnel:status', status: tunnelStatus, hostname: config.tunnel?.hostname || '', sshHostname: config.tunnel?.sshHostname || '', enabled: config.tunnel?.enabled || false })
}

// ── Auto-provisioning ─────────────────────────────────────────────────────────
// On first boot with no tunnel token, call the provisioning service to get one
const PROVISION_URL = 'https://provision.kinkcontrol.org/register'
const PROVISION_KEY = process.env.PROVISION_KEY || ''

async function waitForInternet(maxWaitMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await fetch('https://1.1.1.1', { signal: AbortSignal.timeout(3000) })
      if (r.ok || r.status) return true
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 3000))
  }
  return false
}

async function autoProvision() {
  if (config.tunnel?.token) return  // already provisioned
  const deviceId = (config.boxId || '').trim().toLowerCase()
  if (!deviceId || !PROVISION_KEY) {
    console.log('[provision] skipping — no boxId or PROVISION_KEY set')
    return
  }
  console.log('[provision] no tunnel token — waiting for internet...')
  broadcast({ type: 'tunnel:status', status: 'connecting', enabled: true, hostname: '', provisioning: true })
  const online = await waitForInternet(120000)
  if (!online) {
    console.log('[provision] no internet after 2 min — will retry on next start')
    broadcast({ type: 'tunnel:status', status: 'disconnected', enabled: false, hostname: '' })
    return
  }
  console.log(`[provision] registering device: ${deviceId}`)
  try {
    const r = await fetch(PROVISION_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-provision-key': PROVISION_KEY },
      body:    JSON.stringify({ deviceId }),
      signal:  AbortSignal.timeout(30000),
    })
    const data = await r.json()
    if (!data.ok) throw new Error(data.error || 'unknown provisioning error')
    config.tunnel = {
      enabled:     true,
      token:       data.token,
      hostname:    data.webHostname,
      sshHostname: data.sshHostname,
    }
    saveConfig(config)
    console.log(`[provision] ✓ registered!  Web: ${data.webHostname}  SSH: ${data.sshHostname}`)
    tunnelStart()
  } catch (err) {
    console.error('[provision] failed:', err.message, err.cause?.message || '', err.cause?.code || '', '— retrying in 60s')
    broadcast({ type: 'tunnel:status', status: 'disconnected', enabled: false, hostname: '' })
    setTimeout(autoProvision, 60000)
  }
}

// ── BLE ───────────────────────────────────────────────────────────────────────
const { bluetooth, destroy } = createBluetooth()
// Prevent dbus-next bus/connection error events from crashing the process
// These fire when a BLE device disconnects mid-GATT (unhandled error event kills Node)
if (bluetooth.dbus) {
  bluetooth.dbus.on('error', err => console.error('[dbus error]', err?.message || err))
  if (bluetooth.dbus._connection) {
    bluetooth.dbus._connection.on('error', err => console.error('[dbus conn error]', err?.message || err))
  }
}
let adapter = null
async function getAdapter() {
  if (!adapter) adapter = await bluetooth.defaultAdapter()
  return adapter
}


// Global BLE device proxy cache — avoids creating multiple DBus proxies for the same address
// which leaks match rules and causes dbus connection failures
const _bleDeviceCache = new Map()   // addr.toLowerCase() -> {proxy, name}
const _bleDevicePending = new Map()  // addr -> Promise (dedup concurrent requests)
async function getCachedDevice(adp, addr) {
  const key = addr.toLowerCase()
  if (_bleDeviceCache.has(key)) return _bleDeviceCache.get(key)
  if (_bleDevicePending.has(key)) return _bleDevicePending.get(key)
  const p = adp.getDevice(addr).then(async proxy => {
    const name = await proxy.getName().catch(()=>'')
    const result = { proxy, name }
    _bleDeviceCache.set(key, result)
    _bleDevicePending.delete(key)
    return result
  }).catch(err => { _bleDevicePending.delete(key); throw err })
  _bleDevicePending.set(key, p)
  return p
}


// BLE exclusive-access mutex — prevents concurrent connect+scan from different device classes
let _bleConnecting = 0
// Register a JustWorks pairing agent so pair() can complete without user input
async function registerPairingAgent() {
  try {
    const dbus = bluetooth.dbus
    const AGENT_PATH = '/com/edgecontroller/agent'
    // Implement the org.bluez.Agent1 interface — auto-accept everything
    await dbus.requestName('com.edgecontroller.agent', 0).catch(()=>{})
    const iface = {
      name: 'org.bluez.Agent1',
      methods: {
        Release:              { inSignature:'',   outSignature:'' },
        RequestPinCode:       { inSignature:'o',  outSignature:'s' },
        DisplayPinCode:       { inSignature:'os', outSignature:'' },
        RequestPasskey:       { inSignature:'o',  outSignature:'u' },
        DisplayPasskey:       { inSignature:'ouu',outSignature:'' },
        RequestConfirmation:  { inSignature:'ou', outSignature:'' },
        RequestAuthorization: { inSignature:'o',  outSignature:'' },
        AuthorizeService:     { inSignature:'os', outSignature:'' },
        Cancel:               { inSignature:'',   outSignature:'' },
      },
      Release:              ()=>{ console.log('[agent] Released') },
      RequestPinCode:       ()=>{ console.log('[agent] RequestPinCode'); return '0000' },
      DisplayPinCode:       ()=>{ console.log('[agent] DisplayPinCode') },
      RequestPasskey:       ()=>{ console.log('[agent] RequestPasskey'); return 0 },
      DisplayPasskey:       ()=>{ console.log('[agent] DisplayPasskey') },
      RequestConfirmation:  ()=>{ console.log('[agent] RequestConfirmation — auto-accepting') },
      RequestAuthorization: ()=>{ console.log('[agent] RequestAuthorization — auto-accepting') },
      AuthorizeService:     ()=>{ console.log('[agent] AuthorizeService — auto-accepting') },
      Cancel:               ()=>{ console.log('[agent] Cancel') },
    }
    dbus.exportInterface(iface, AGENT_PATH)
    // Register with BlueZ AgentManager
    const agentMgr = dbus.getProxyObject('org.bluez', '/org/bluez')
    const mgr = await agentMgr.then ? (await agentMgr).getInterface('org.bluez.AgentManager1') : agentMgr.getInterface('org.bluez.AgentManager1')
    await mgr.RegisterAgent(AGENT_PATH, 'NoInputNoOutput')
    await mgr.RequestDefaultAgent(AGENT_PATH)
    console.log('[agent] JustWorks pairing agent registered')
  } catch(e) {
    console.log('[agent] Agent registration failed (non-fatal):', e.message)
  }
}
// registerPairingAgent() — temporarily disabled for coyote debugging

const devices = {}
const clients = new Set()
let streamDeck = null  // declared early to avoid TDZ when devices auto-connect at startup
function broadcast(msg) {
  const s = JSON.stringify(msg)
  for (const ws of clients) if (ws.readyState === 1) ws.send(s)
  // Notify Stream Deck on device state changes
  if (msg.type === 'device:status' || msg.type === 'eom:config' || msg.type === 'eom:denial') {
    streamDeck?.onDeviceUpdate()
  }
  // Notify Stream Deck on macro events
  if (['macro:running','macro:stopped','macro:step','macro:wait','macro:countdown','macro:ramp','macro:label'].includes(msg.type)) {
    streamDeck?.onMacroEvent(msg)
  }
  // Reload waveform list when waveforms are added/deleted
  if (msg.type === 'waveforms:updated') {
    streamDeck?.reloadWaveforms()
  }
}

function encodeFreq(hz) {
  hz = Math.max(10, Math.min(1000, hz))
  if (hz <= 100) return hz
  if (hz <= 600) return Math.round((hz - 100) / 5) + 100
  return Math.round((hz - 600) / 10) + 200
}

function computeWave(wfId, tick, amp, speed=1) {
  const custom = waveformStore.custom.find(w => w.id === wfId)
  if (custom && custom.frames.length > 0) {
    // speed shifts the frame index — faster speed = advance more frames per tick
    const frame = custom.frames[Math.floor(tick * speed) % custom.frames.length]
    // Audio frames stored as plain amplitude integers; legacy format uses {segs:[...]}
    if (typeof frame === 'number') {
      const a = Math.min(100, Math.round(frame * amp / 100))
      return [[25,a],[25,a],[25,a],[25,a]]
    }
    const segs = frame.segs || []
    // Ensure exactly 4 sub-pulses — map each slot to the nearest seg
    return Array.from({length:4}, (_,i) => {
      const s = segs[Math.floor(i * segs.length / 4)] || segs[0] || {f:25,a:0}
      return [s.f, Math.min(100, Math.round(s.a * amp / 100))]
    })
  }
  // Built-in waveforms: each of the 4 sub-pulses uses a different phase point so amplitude
  // changes 4× per packet (40 effective steps/sec vs 10) — eliminates staircase jitter.
  // speed scales the phase rate — higher speed = faster cycle.
  const p = i => (tick * 4 + i) * speed
  const sv = (i, rate, offset=0) => Math.round(((Math.sin(p(i)*rate+offset)+1)/2)*amp)
  switch (wfId) {
    // pulse: 25Hz — smooth deep feel on the on/off envelope
    case 'pulse':     return Array.from({length:4},(_,i)=>{
      const ph=p(i)%40
      const env=ph<8?(1-Math.cos(ph/8*Math.PI))/2:ph<24?1:ph<32?(1+Math.cos((ph-24)/8*Math.PI))/2:0
      return [25,Math.round(env*amp)]
    })
    // breathe: 25Hz — sweet spot between deep thump (10Hz) and prickly (50Hz+), 6s cycle
    case 'breathe':   return Array.from({length:4},(_,i)=>[ 25, sv(i,0.025) ])
    // tidal: 25Hz rolling wave
    case 'tidal':     return Array.from({length:4},(_,i)=>[ 25, Math.round((Math.abs(Math.sin(p(i)*0.0125))*0.9+0.05)*amp) ])
    // wave: 25Hz dual-phase flowing sensation
    case 'wave':      return Array.from({length:4},(_,i)=>[ 25, i<2?sv(i,0.025):sv(i,0.025,1.57) ])
    // thud: 10Hz — deep thumping impact, low freq is intentional
    case 'thud':      return Array.from({length:4},(_,i)=>{
      const ph=p(i)%40
      const env=ph<12?(1-Math.cos(ph/12*Math.PI))/2:ph<20?1-(ph-12)/8:0
      return [10,Math.round(env*amp)]
    })
    // flutter: 25Hz on/off bursts
    case 'flutter':   return Array.from({length:4},(_,i)=>{ const on=p(i)%8<4; return [25,on?amp:0] })
    // ramp: 25Hz sawtooth envelope
    case 'ramp':      return Array.from({length:4},(_,i)=>{
      const ph=p(i)%80
      const env=ph<72?ph/72:(80-ph)/8*Math.cos((ph-72)/8*Math.PI*0.5)
      return [25,Math.max(0,Math.round(env*amp))]
    })
    // heartbeat: 25Hz
    case 'heartbeat': return Array.from({length:4},(_,i)=>{ const f=p(i)%32; const hv=f===0?amp:f===4?Math.round(amp*.5):f===8?Math.round(amp*.7):f===12?Math.round(amp*.3):0; return [25,hv] })
    // steps: 25Hz discrete amplitude steps
    case 'steps':     return Array.from({length:4},(_,i)=>{ const s=Math.floor((p(i)%80)/20); return [25,[Math.round(amp*.25),Math.round(amp*.5),Math.round(amp*.75),amp][s]] })
    // buzz: kept high — this one is supposed to feel like a buzz, not a wave
    case 'buzz':      return [[80,amp],[80,amp],[80,amp],[80,amp]]
    default:          return [[25,0],[25,0],[25,0],[25,0]]
  }
}

class CoyoteDevice {
  constructor(id, name, mac, bleName) {
    this.id=id; this.name=name; this.type='coyote'; this.mac=(mac||'').toLowerCase()
    this.bleName=bleName||null; this.status='disconnected'
    this.gattServer=null; this.writeChar=null; this.notifyChar=null
    this.channels={ A:{intensity:0,waveform:'pulse',speed:1}, B:{intensity:0,waveform:'pulse',speed:1} }
    this._smoothA=0; this._smoothB=0  // smoothed intensity (0-200), lerped toward target each packet
    this._tick=0; this._interval=null; this._device=null; this._connectLock=false
    this._connectedAddr=null  // actual BLE address we connected to
    this._retryDelay=5000  // exponential backoff on repeated failures
  }

  async connect() {
    if (this._connectLock || this.status==='connected') return
    this._connectLock=true; this.status='connecting'
    broadcast({ type:'device:status', id:this.id, status:'connecting' })
    try {
      const adp = await getAdapter()
      console.log(`[${this.id}] Starting discovery...`)
      while (_bleConnecting > 0) { await new Promise(r=>setTimeout(r,2000)) }
      if (!await adp.isDiscovering()) await adp.startDiscovery()
      const foundResult = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Device not found in 15s')), 15000)
        const check = async () => {
          try {
            const addrs = await adp.devices()
            for (const addr of addrs) {
              try {
                const {proxy: d, name} = await getCachedDevice(adp, addr)
                if (name.startsWith('47L')) {
                  if (this.bleName && name !== this.bleName) continue
                  // If this device has a specific MAC configured, only match that exact device
                  if (this.mac && addr.toLowerCase() !== this.mac.toLowerCase()) continue
                  // Skip if this MAC is already in use by another connected Coyote
                  const alreadyUsed = Object.values(devices).some(
                    other => other !== this && other.type === 'coyote' &&
                             other.status === 'connected' &&
                             addr.toLowerCase() === (other._connectedAddr || other.mac || '')
                  )
                  if (alreadyUsed) { console.log(`[${this.id}] Skipping ${addr} — already connected to ${name}`); continue }
                  clearTimeout(timer); console.log(`[${this.id}] Found: ${name} at ${addr}`); resolve({d, addr}); return
                }
              } catch {}
            }
          } catch {}
          setTimeout(check, 500)
        }
        check()
      })
      const device = foundResult.d
      this._device=device
      this._connectedAddr=foundResult.addr.toLowerCase()
      _bleConnecting++
      // Stop discovery and VERIFY it stopped — BCM4345C0 chip can't connect while scanning
      for (let i=0; i<8; i++) {
        await adp.stopDiscovery().catch(()=>{})
        await new Promise(r=>setTimeout(r,400))
        try { if (!await adp.isDiscovering()) { console.log(`[${this.id}] Scan stopped`); break } } catch {}
        console.log(`[${this.id}] Waiting for scan to stop (${i+1}/8)...`)
      }
      // BCM4345C0 needs extra settle time after scan stops before it can initiate a connection.
      // Do NOT call device.disconnect() here — if the device was never connected, it can corrupt
      // BlueZ's internal device state and cause immediate le-connection-abort-by-local on connect.
      await new Promise(r=>setTimeout(r,3000))
      // No pairing needed — Coyote 3 uses plain BLE connect, no SMP pairing
      // Race against 20s timeout — device.connect() can hang indefinitely if the device
      // is discoverable but not accepting connections (firmware quirk / BT stack issue)
      console.log(`[${this.id}] Connecting...`)
      await Promise.race([
        device.connect(),
        new Promise((_,rej) => setTimeout(()=>rej(new Error('connect timeout: device not responding after 20s')), 20000))
      ])
      // Race device.gatt() against a 15s timeout — waitPropChange(ServicesResolved) can hang
      // if the device disconnects before GATT discovery completes
      this.gattServer = await Promise.race([
        device.gatt(),
        new Promise((_,rej) => setTimeout(()=>rej(new Error('GATT timeout: ServicesResolved took >15s')), 15000))
      ])
      const svc = await this.gattServer.getPrimaryService('0000180c-0000-1000-8000-00805f9b34fb')
      this.writeChar  = await svc.getCharacteristic('0000150a-0000-1000-8000-00805f9b34fb')
      this.notifyChar = await svc.getCharacteristic('0000150b-0000-1000-8000-00805f9b34fb')
      await this.notifyChar.startNotifications()
      this.notifyChar.on('valuechanged', buf => {
        broadcast({ type:'device:notify', id:this.id, hex:Buffer.from(buf).toString('hex') })
      })
      // 0xBF init: set limits + frequency/intensity balance to defaults
      await this.writeChar.writeValue(Buffer.from([0xBF, 0xC8, 0xC8, 0x00, 0x00, 0x00, 0x00]), { type:'command' })
      await new Promise(r=>setTimeout(r,200))
      this._connectLock=false; this.status='connected'
      this._retryDelay=5000; this._leAbortCount=0  // reset on success
      broadcast({ type:'device:status', id:this.id, status:'connected' })
      _bleConnecting--
      console.log(`[${this.id}] Ready`)
      this._startSending()
      try {
        device.helper.on('PropertiesChanged', (iface, props) => {
          if (iface==='org.bluez.Device1' && props.Connected?.value===false) {
            console.log(`[${this.id}] Disconnected`)
            this._stopSending(); this._connectLock=false; this.status='disconnected'; this._connectedAddr=null; this._smoothA=0; this._smoothB=0
            broadcast({ type:'device:status', id:this.id, status:'disconnected' })
          }
        })
      } catch {}
    } catch (err) {
      console.error(`[${this.id}] connect error:`, err.message)
      if (_bleConnecting > 0) _bleConnecting--
      this.status='error'; this._connectLock=false
      broadcast({ type:'device:status', id:this.id, status:'error', error:err.message })
      try { await adapter?.stopDiscovery() } catch {}
      const delay = this._retryDelay
      this._retryDelay = Math.min(this._retryDelay * 2, 60000)
      console.log(`[${this.id}] Retrying in ${delay/1000}s (backoff: ${this._retryDelay/1000}s next)`)
      setTimeout(()=>this.connect().catch(e=>console.error(`[${this.id}] reconnect:`,e.message)), delay)
    }
  }

  async disconnect() {
    this._stopSending()
    try { if (this._device) await this._device.disconnect() } catch {}
    this._connectedAddr=null; this._smoothA=0; this._smoothB=0; this.status='disconnected'
    broadcast({ type:'device:status', id:this.id, status:'disconnected' })
  }

  setChannel(ch, { intensity, waveform, speed }={}) {
    if (intensity!==undefined) this.channels[ch].intensity=Math.max(0,Math.min(200,intensity))
    if (waveform!==undefined)  this.channels[ch].waveform=waveform
    if (speed!==undefined)     this.channels[ch].speed=Math.max(0.25,Math.min(4,speed))
    broadcast({ type:'device:state', id:this.id, channels:this.channels })
  }

  _buildPacket() {
    const t=this._tick

    // Smooth intensity toward target: slow rise (~1s), faster fall (~400ms), fast to zero
    const tA=this.channels.A.intensity, tB=this.channels.B.intensity
    const rateA = tA > this._smoothA ? 0.18 : (tA===0 ? 0.45 : 0.22)
    const rateB = tB > this._smoothB ? 0.18 : (tB===0 ? 0.45 : 0.22)
    this._smoothA += (tA - this._smoothA) * rateA
    this._smoothB += (tB - this._smoothB) * rateB
    if (Math.abs(this._smoothA - tA) < 0.4) this._smoothA = tA
    if (Math.abs(this._smoothB - tB) < 0.4) this._smoothB = tB

    const aAmp=Math.min(100,Math.round(this._smoothA/2))
    const bAmp=Math.min(100,Math.round(this._smoothB/2))
    const aW=computeWave(this.channels.A.waveform,t,aAmp,this.channels.A.speed||1)
    const bW=computeWave(this.channels.B.waveform,t,bAmp,this.channels.B.speed||1)
    const buf=Buffer.alloc(20)
    buf[0]=0xB0; buf[1]=((t%16)<<4)|0x0F
    buf[2]=Math.min(200,Math.round(this._smoothA))
    buf[3]=Math.min(200,Math.round(this._smoothB))
    for(let i=0;i<4;i++) buf[4+i]=encodeFreq(aW[i][0])
    for(let i=0;i<4;i++) buf[8+i]=Math.min(100,aW[i][1])
    for(let i=0;i<4;i++) buf[12+i]=encodeFreq(bW[i][0])
    for(let i=0;i<4;i++) buf[16+i]=Math.min(100,bW[i][1])
    return buf
  }

  _startSending() {
    this._sendActive = true
    const loop = async () => {
      if (!this._sendActive) return
      const t0 = Date.now()
      if (this.writeChar && this.status === 'connected') {
        try {
          await this.writeChar.writeValue(this._buildPacket(), { type:'command' })
          this._tick++
        } catch(e) {
          console.error(`[${this.id}] send:`, e.message)
          this._sendActive = false; this.status = 'disconnected'
          broadcast({ type:'device:status', id:this.id, status:'disconnected' })
          return
        }
      }
      if (this._sendActive) {
        // Target 100ms per cycle; subtract write time so we stay on schedule
        this._sendTimer = setTimeout(loop, Math.max(5, 100 - (Date.now() - t0)))
      }
    }
    loop()
  }

  _stopSending() {
    this._sendActive = false
    if (this._sendTimer) { clearTimeout(this._sendTimer); this._sendTimer = null }
  }

  toJSON() {
    return { id:this.id, type:'coyote', name:this.name, bleName:this.bleName, mac:this.mac, status:this.status, channels:this.channels }
  }
}



// ── PawPrints Wireless Sensor ─────────────────────────────────────────────────
class PawPrintsDevice {
  constructor(id, name, mac, bleName) {
    this.id=id; this.name=name; this.type='pawprints'
    this.mac=(mac||'').toLowerCase(); this.bleName=bleName||null
    this.status='disconnected'
    this.gattServer=null; this.writeChar=null; this.notifyChar=null
    this.buttons=[false,false,false]
    this.accel={x:0,y:0,z:0}
    this.gyro={x:0,y:0,z:0}
    this.battery=null
    this._device=null; this._connectLock=false; this._connectedAddr=null
    this._retryDelay=5000
    this._b3Timer=null
    this._lastCmd1Time=0
    this._cmd1Interval=100
  }

  async connect() {
    if (this._connectLock || this.status==='connected') return
    this._connectLock=true; this.status='connecting'
    broadcast({ type:'device:status', id:this.id, status:'connecting' })
    try {
      const adp=await getAdapter()
      console.log(`[${this.id}] PawPrints: starting discovery...`)
      while (_bleConnecting > 0) { await new Promise(r=>setTimeout(r,2000)) }
      if (!await adp.isDiscovering()) await adp.startDiscovery()
      const foundResult=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('PawPrints not found in 25s')),25000)
        const check=async()=>{
          // Yield the chip immediately if something else is connecting
          if (_bleConnecting > 0) {
            clearTimeout(timer)
            await adp.stopDiscovery().catch(()=>{})
            reject(new Error('BLE busy, will retry'))
            return
          }
          try {
            const addrs=await adp.devices()
            for (const addr of addrs) {
              try {
                const {proxy: d, name}=await getCachedDevice(adp, addr)
                const addrL = addr.toLowerCase()
                // Match by name prefix OR by stored MAC (directed advertising has no name)
                const nameMatch = name.startsWith('47L120')
                const macMatch = this.mac && addrL === this.mac.toLowerCase()
                if (nameMatch || macMatch) {
                  if (nameMatch && this.bleName && name!==this.bleName) continue
                  if (nameMatch && this.mac && addrL!==this.mac.toLowerCase()) continue
                  const alreadyUsed=Object.values(devices).some(
                    other=>other!==this && other.type==='pawprints' &&
                           other.status==='connected' &&
                           addrL===(other._connectedAddr||other.mac||'')
                  )
                  if (alreadyUsed) continue
                  // Only accept if RSSI is live (non-zero = device actively advertising right now)
                  // RSSI=0/null means device is in BlueZ cache but not currently advertising
                  const rssi = await d.getRSSI().catch(()=>null)
                  if (!rssi) continue
                  clearTimeout(timer); console.log(`[${this.id}] Found: ${name||'(no name)'} at ${addr} (RSSI ${rssi})`); resolve({d,addr}); return
                }
              } catch {}
            }
          } catch {}
          setTimeout(check,500)
        }
        check()
      })
      this._device=foundResult.d; this._connectedAddr=foundResult.addr.toLowerCase()
      _bleConnecting++
      // Stop discovery — BCM4345 can't scan and connect at the same time
      await adp.stopDiscovery().catch(()=>{})
      await new Promise(r=>setTimeout(r,500))
      // Disable bonding so BlueZ does NOT send SMP Pairing Request (PawPrints rejects SMP, causing abort)
      await new Promise(res => exec('sudo btmgmt bondable off', res))
      await new Promise(res => exec('sudo bluetoothctl trust ' + foundResult.addr.toUpperCase(), res))
      await new Promise(r=>setTimeout(r,200))
      console.log(`[${this.id}] Connecting...`)
      // Connect with retry for 'In Progress' (happens when pm2 restarts mid-connect, clears in ~5s)
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await Promise.race([
            this._device.connect(),
            new Promise((_,rej)=>setTimeout(()=>rej(new Error('connect timeout')),20000))
          ])
          break
        } catch(e) {
          if (e.message && e.message.includes('In Progress') && attempt < 3) {
            console.log(`[${this.id}] In Progress (attempt ${attempt}), waiting 5s for BlueZ to clear...`)
            await new Promise(r=>setTimeout(r,5000))
            continue
          }
          throw e
        }
      }
      console.log(`[${this.id}] HCI connected OK, getting GATT...`)
      // GATT services should be cached from previous attempts — should be fast
      this.gattServer=await Promise.race([
        this._device.gatt(),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('GATT timeout')),10000))
      ])
      const svc=await this.gattServer.getPrimaryService('0000180c-0000-1000-8000-00805f9b34fb')
      this.writeChar =await svc.getCharacteristic('0000150a-0000-1000-8000-00805f9b34fb')
      // Send 0x50 config IMMEDIATELY — device disconnects if not received quickly
      const cfg=Buffer.alloc(17,0)
      cfg[0]=0x50; cfg[1]=0x04; cfg[2]=0xD0
      await this.writeChar.writeValue(cfg,{type:'command'})
      await new Promise(r=>setTimeout(r,150))
      // Enable data stream
      await this.writeChar.writeValue(Buffer.from([0x53,0x04,0xFF]),{type:'command'})
      // Now set up notifications (0x50 already sent — device won't disconnect)
      this.notifyChar=await svc.getCharacteristic('0000150b-0000-1000-8000-00805f9b34fb')
      await this.notifyChar.startNotifications()
      this.notifyChar.on('valuechanged', buf=>this._onNotify(Buffer.from(buf)))

      this._connectLock=false; this.status='connected'; this._retryDelay=5000
      broadcast({ type:'device:status', id:this.id, status:'connected' })
      _bleConnecting--
      exec('sudo btmgmt bondable on', ()=>{})
      console.log(`[${this.id}] PawPrints ready`)
      try {
        this._device.helper.on('PropertiesChanged',(iface,props)=>{
          if (iface==='org.bluez.Device1' && props.Connected?.value===false) {
            console.log(`[${this.id}] Disconnected`)
            this._connectLock=false; this.status='disconnected'; this._connectedAddr=null
            this.buttons=[false,false,false]; this.accel={x:0,y:0,z:0}
            broadcast({ type:'device:status', id:this.id, status:'disconnected' })
          }
        })
      } catch {}
    } catch(err) {
      exec('sudo btmgmt bondable on', ()=>{})
      console.error(`[${this.id}] connect error:`,err.message)
      if (_bleConnecting > 0) _bleConnecting--
      this.status='error'; this._connectLock=false
      broadcast({ type:'device:status', id:this.id, status:'error', error:err.message })
      try { await adapter?.stopDiscovery() } catch {}
      const delay=this._retryDelay
      const isTransient = err.message && (
        err.message.includes('le-connection-abort-by-local') ||
        err.message.includes('not found in') ||
        err.message.includes('connect timeout') ||
        err.message.includes('In Progress')
      )
      if (err.message && err.message.includes('le-connection-abort-by-local')) {
        // LL timing failure (0x3E): restart bluetooth to clear BlueZ passive-scan state,
        // but ONLY if no coyotes are currently connected — avoid disrupting active sessions.
        const coyoteActive = Object.values(devices).some(d => d.type==='coyote' && d.status==='connected')
        if (!coyoteActive) {
          console.log('[pawprints] Restarting bluetooth to clear LL failure state (no active coyote session)...')
          await new Promise(res=>exec('sudo systemctl restart bluetooth',res))
          await new Promise(r=>setTimeout(r,3000))
        }
      }
      if (!isTransient) {
        this._retryDelay=Math.min(this._retryDelay*2,60000)
      }
      console.log(`[${this.id}] Stopped — click Connect to retry`)
    }
  }

  _b3Pressed(v) {
    const was=this.buttons[2]
    if (was===v) return
    this.buttons=[this.buttons[0],this.buttons[1],v]
    broadcast({ type:'pawprints:data', id:this.id, buttons:this.buttons, accel:this.accel, raw:'' })
    console.log('[' + this.id + '] B3=' + v)
  }

  _onNotify(buf) {
    if (buf.length < 13) return
    const cmd=buf[0]
    if (cmd===0x01) {
      // Normal sensor packet. B3 is detected when cmd=0x01 packets stop arriving
      // (cmd=0x00 packets may still come during B3 press but don't count as "active")
      const now=Date.now()
      if (this._lastCmd1Time>0) { const iv=now-this._lastCmd1Time; if (iv<500) this._cmd1Interval=this._cmd1Interval*0.8+iv*0.2 }
      this._lastCmd1Time=now
      clearTimeout(this._b3Timer)
      if (this.buttons[2]) this._b3Pressed(false)
      // 2.5x observed interval: 1 dropped packet (2x) doesn't fire, 2 dropped (3x) does
      this._b3Timer = setTimeout(() => this._b3Pressed(true), Math.max(200, this._cmd1Interval*2.5))
      // buf[1]: B1 inverted (0x00=pressed, 0x01=not) -- user confirmed
      // buf[2]: B2 inverted (0x00=pressed, 0x01=not) -- by analogy
      // buf[4,5,6]: gyro X,Y,Z as signed int8 (confirmed by spin test)
      // buf[7-12]: accel X,Y,Z as int16BE
      const b1=buf[1]===0x00
      const b2=buf[2]===0x00
      const b3=this.buttons[2]
      const gx=buf.readInt8(4)
      const gy=buf.readInt8(5)
      const gz=buf.readInt8(6)
      const x=buf.readInt16BE(7)
      const y=buf.readInt16BE(9)
      const z=buf.readInt16BE(11)
      const wasPressed=this.buttons.some(Boolean)
      this.buttons=[b1,b2,b3]
      this.accel={x,y,z}
      this.gyro={x:gx,y:gy,z:gz}
      if (b1||b2||b3||wasPressed) console.log('[' + this.id + '] buttons: [' + b1 + ',' + b2 + ',' + b3 + '] accel: ' + x + ',' + y + ',' + z)
      broadcast({ type:'pawprints:data', id:this.id, buttons:this.buttons, accel:this.accel, gyro:this.gyro, raw:buf.toString('hex') })
    } else if (cmd===0x00) {
      // cmd=0x00 packets arrive periodically but carry no useful sensor data
    } else if (cmd===0xD0) {
      // Physical passthrough mode: buf[1]=btn3, buf[2]=btn2, buf[3]=btn1(top)
      // buf[8-9]=X int16BE, buf[10-11]=Y, buf[12-13]=Z
      if (buf.length < 14) return
      const b1=buf[3]===0x00
      const b2=buf[2]===0x00
      const b3=buf[1]===0x00
      const x=buf.readInt16BE(8)
      const y=buf.readInt16BE(10)
      const z=buf.readInt16BE(12)
      this.buttons=[b1,b2,b3]
      this.accel={x,y,z}
      broadcast({ type:'pawprints:data', id:this.id, buttons:this.buttons, accel:this.accel, raw:buf.toString('hex') })
    } else if (cmd===0x51) {
      if (buf.length>=4) { this.battery=buf[3]; broadcast({ type:'pawprints:battery', id:this.id, battery:this.battery }) }
    }
  }

  async disconnect() {
    try { if (this._device) await this._device.disconnect() } catch {}
    this._connectedAddr=null; this.status='disconnected'
    this.buttons=[false,false,false]; this.accel={x:0,y:0,z:0}
    broadcast({ type:'device:status', id:this.id, status:'disconnected' })
  }

  toJSON() {
    return { id:this.id, type:'pawprints', name:this.name, bleName:this.bleName, mac:this.mac, status:this.status, buttons:this.buttons, accel:this.accel, battery:this.battery }
  }
}

// ── Nimble Stroker Device ─────────────────────────────────────────────────────
// 7-byte binary serial protocol at 115200 baud, 50Hz send rate
// Packet: [statusByte][posHi][posLo][forceHi][forceLo][cksumLo][cksumHi]
class NimbleDevice {
  constructor(id, name, ttyPath) {
    this.id=id; this.name=name; this.type='nimble'
    this.ttyPath=ttyPath||'/dev/ttyUSB0'
    this.status='disconnected'
    this._fd=null; this._sendTimer=null; this._oscTimer=null; this._rxBuf=Buffer.alloc(0)
    // Command state
    this.position=0       // -1000 to +1000 (direct position control)
    this.force=0          // 0 to 1023  (0 = device goes idle)
    this.activated=false
    // Oscillation mode
    this.oscillating=false
    this.oscSpeed=0.5     // Hz — strokes per second
    this.oscDepth=800     // amplitude 0-1000
    this.oscOffset=0      // centre offset -500 to +500
    this._oscPhase=0
    // Feedback from device
    this.feedback={ position:0, force:0, tempLimiting:false, sensorFault:false, present:false }
  }

  _buildPacket() {
    // Protocol: little-endian, sign-magnitude position, 10-bit force
    // Byte0: SYSTEM_TYPE=0b100 in bits[7:5], ACK in bit[0]
    // Byte1: posLow(7:0)  Byte2: NODE_TYPE(7:5)|sign(2)|posHi(1:0)
    // Byte3: forceLow(7:0) Byte4: forceHi(1:0)
    // Bytes5-6: checksum little-endian
    const buf=Buffer.alloc(7)
    const pos=Math.max(-1000,Math.min(1000,Math.round(this.position)))
    const posAbs=Math.abs(pos); const posSign=pos<0?1:0
    const frc=Math.max(0,Math.min(1023,Math.round(this.force)))
    buf[0]=0x80|(this.activated?1:0)   // SYSTEM_TYPE=0b100, ACK
    buf[1]=posAbs&0xFF                 // position low byte
    buf[2]=(posSign<<2)|((posAbs>>8)&0x03) // NODE_TYPE=0b000, sign, posHi
    buf[3]=frc&0xFF                    // force low byte
    buf[4]=(frc>>8)&0x03              // force high 2 bits
    const ck=buf[0]+buf[1]+buf[2]+buf[3]+buf[4]
    buf[5]=ck&0xFF; buf[6]=(ck>>8)&0xFF
    return buf
  }

  _parsePacket(buf) {
    if(buf.length<7) return false
    // Validate checksum (little-endian 16-bit sum of bytes 0-4)
    const ck=buf[0]+buf[1]+buf[2]+buf[3]+buf[4]
    if(buf[5]!=(ck&0xFF)||buf[6]!=((ck>>8)&0xFF)) return false
    // Position: sign-magnitude, sign at buf[2][2], high bits at buf[2][1:0], low at buf[1]
    const posSign=(buf[2]>>2)&0x01
    const posAbs=((buf[2]&0x03)<<8)|buf[1]
    const pos=posSign?-posAbs:posAbs
    // Force feedback: sign at buf[4][5], high bits at buf[4][1:0], low at buf[3]
    const frcSign=(buf[4]>>5)&0x01
    const frcAbs=((buf[4]&0x03)<<8)|buf[3]
    const frc=frcSign?-frcAbs:frcAbs
    this.feedback={ position:pos, force:frc, tempLimiting:!!(buf[0]&0x04), sensorFault:!!(buf[0]&0x02), present:true }
    return true
  }

  _startOscillation() {
    if(this._oscTimer) return
    const dt=0.02  // 50Hz
    this._oscTimer=setInterval(()=>{
      if(!this.oscillating||!this.activated){ return }
      this._oscPhase+=2*Math.PI*this.oscSpeed*dt
      this.position=Math.round(this.oscOffset+this.oscDepth*Math.sin(this._oscPhase))
    }, 20)
  }

  async connect() {
    if(this._fd!==null) return
    this.status='connecting'
    broadcast({type:'device:status',id:this.id,status:'connecting'})
    try {
      // Use raw fs.open — no TIOCEXCL exclusive lock unlike serialport npm
      const fd=await new Promise((res,rej)=>fsOpen(this.ttyPath,'r+',(e,fd)=>e?rej(e):res(fd)))
      this._fd=fd
      // Configure port: 115200 baud, raw mode, no echo, ignore modem lines
      execSync(`stty -F ${this.ttyPath} 115200 raw -echo -hupcl clocal cs8 -cstopb -parenb`)
      this.status='connected'; this.activated=true; this.force=200
      broadcast({type:'device:status',id:this.id,status:'connected'})
      console.log(`[${this.id}] Nimble connected on ${this.ttyPath}`)

      // Send loop 50Hz using raw fd write
      this._sendTimer=setInterval(()=>{
        if(this._fd===null) return
        const buf=this._buildPacket()
        fsWrite(this._fd,buf,0,buf.length,null,(err)=>{
          if(err&&this._fd!==null){ console.error(`[${this.id}] write err:`,err.message); this._cleanup('error') }
        })
      },20)

      // Oscillation timer
      this._startOscillation()

      // Read loop — blocks in libuv thread pool until bytes arrive (no busy-wait)
      const rbuf=Buffer.alloc(64)
      const readLoop=()=>{
        if(this._fd===null) return
        fsRead(this._fd,rbuf,0,rbuf.length,null,(err,n)=>{
          if(this._fd===null) return
          if(err){ console.error(`[${this.id}] read err:`,err.message); this._cleanup('error'); return }
          if(n>0){
            const data=rbuf.slice(0,n)
            this._rxBuf=Buffer.concat([this._rxBuf,data])
            while(this._rxBuf.length>=7){
              if(this._parsePacket(this._rxBuf.slice(0,7))){
                this._rxBuf=this._rxBuf.slice(7)
                broadcast({type:'nimble:feedback',id:this.id,feedback:this.feedback})
              } else { this._rxBuf=this._rxBuf.slice(1) }
            }
          }
          setImmediate(readLoop)
        })
      }
      readLoop()
    } catch(e) {
      this._cleanup('error')
      console.error(`[${this.id}] connect failed:`,e.message)
      throw e
    }
  }

  _cleanup(status='disconnected') {
    if(this._sendTimer){ clearInterval(this._sendTimer); this._sendTimer=null }
    if(this._oscTimer){ clearInterval(this._oscTimer); this._oscTimer=null }
    this.activated=false; this.oscillating=false
    if(this._fd!==null){ const fd=this._fd; this._fd=null; fsClose(fd,()=>{}) }
    if(this.status!==status){ this.status=status; broadcast({type:'device:status',id:this.id,status}) }
  }

  setPosition(pos) {
    if(this.oscillating) return  // ignore manual position in osc mode
    this.position=Math.max(-1000,Math.min(1000,Math.round(pos)))
    broadcast({type:'device:state',id:this.id,...this.toJSON()})
  }

  setForce(frc) {
    this.force=Math.max(0,Math.min(1023,Math.round(frc)))
    broadcast({type:'device:state',id:this.id,...this.toJSON()})
  }

  setOscillation({speed,depth,offset,running}={}) {
    if(speed!==undefined) this.oscSpeed=Math.max(0.1,Math.min(5,parseFloat(speed)))
    if(depth!==undefined) this.oscDepth=Math.max(0,Math.min(1000,Math.round(depth)))
    if(offset!==undefined) this.oscOffset=Math.max(-500,Math.min(500,Math.round(offset)))
    if(running!==undefined){
      this.oscillating=!!running
      if(!running){ this.position=this.oscOffset }  // park at centre when stopped
    }
    broadcast({type:'device:state',id:this.id,...this.toJSON()})
  }

  stop() {
    this.oscillating=false; this.position=0; this.force=0; this.activated=false
    broadcast({type:'device:state',id:this.id,...this.toJSON()})
  }

  async disconnect() {
    this._cleanup('disconnected')
  }

  toJSON() {
    return { id:this.id, type:'nimble', name:this.name, ttyPath:this.ttyPath,
             status:this.status, position:this.position, force:this.force,
             activated:this.activated, oscillating:this.oscillating,
             oscSpeed:this.oscSpeed, oscDepth:this.oscDepth, oscOffset:this.oscOffset,
             feedback:this.feedback }
  }
}

// ── E-Stim 2B Device ─────────────────────────────────────────────────────────
// ASCII serial protocol at 9600 baud
// Commands: A<n>\r  B<n>\r  M<n>\r  C<n>\r  D<n>\r  H\r  L\r  K\r  J\r  U\r  E\r
// Response: battery:chA*2:chB*2:freq*2:pwm*2:mode:powerMode:joined:firmware
const ESTIM_MODES = [
  'Pulse','Bounce','Continuous','A Split','B Split','Wave','Waterfall',
  'Squeeze','Milk','Throb','Thrust','Random','Step','Training',
  'Microphone','Stereo','Tickle','Power Level','Mic Level','A&B Link'
]
class EstimDevice {
  constructor(id, name, ttyPath) {
    this.id=id; this.name=name; this.type='estim'
    this.ttyPath=ttyPath||'/dev/ttyUSB1'
    this.status='disconnected'
    this._port=null; this._connectLock=false
    this.channels={ A:{power:0}, B:{power:0} }
    this.mode=0; this.feel=50; this.rate=50; this.powerMode='L'
    this.battery=null; this.firmware=null; this.joined=false
  }

  async connect() {
    if (this._connectLock||this.status==='connected') return
    this._connectLock=true; this.status='connecting'
    broadcast({type:'device:status',id:this.id,status:'connecting'})
    try {
      this._loopId = (this._loopId||0) + 1  // generation counter — invalidates old read loops
      const myLoop = this._loopId
      this._rxBuf = ''
      // Raw fd: no DTR toggling, no FTDI reset
      this._fd = await new Promise((res,rej)=>fsOpen(this.ttyPath,'r+',(e,fd)=>e?rej(e):res(fd)))
      execSync(`stty -F ${this.ttyPath} 9600 raw -echo -hupcl clocal cs8 -cstopb -parenb`)
      this._connectLock=false; this.status='connected'
      broadcast({type:'device:status',id:this.id,status:'connected'})
      this._send('\r')  // query current state
      console.log(`[${this.id}] E-Stim 2B ready on ${this.ttyPath}`)
      // Async read loop — each generation has a unique id so stale loops self-terminate
      const buf = Buffer.alloc(128)
      const readLoop = () => {
        if (this._loopId !== myLoop || !this._fd) return
        fsRead(this._fd, buf, 0, buf.length, null, (err, n) => {
          if (this._loopId !== myLoop || !this._fd) return  // stale loop
          if (err) { this._onDisconnect(); return }
          if (n > 0) {
            this._rxBuf += buf.slice(0, n).toString('ascii')
            let idx
            while ((idx = this._rxBuf.indexOf('\n')) !== -1) {
              const line = this._rxBuf.slice(0, idx).replace(/\r/g,'').trim()
              this._rxBuf = this._rxBuf.slice(idx + 1)
              if (line) this._parseStatus(line)
            }
          }
          readLoop()
        })
      }
      readLoop()
    } catch(e) {
      console.error(`[${this.id}] connect error:`,e.message)
      this._connectLock=false; this.status='error'
      broadcast({type:'device:status',id:this.id,status:'error',error:e.message})
    }
  }

  _onDisconnect() {
    this._loopId = (this._loopId||0) + 1  // invalidate any running read loop
    if (this.status==='connected') {
      this.status='disconnected'
      broadcast({type:'device:status',id:this.id,status:'disconnected'})
    }
    if (this._fd) { fsClose(this._fd,()=>{}); this._fd=null }
    this._connectLock=false
  }

  _parseStatus(line) {
    // Format: battery:chA*2:chB*2:freq*2:pwm*2:mode:powerMode:joined:firmware
    const parts = line.trim().split(':')
    if (parts.length < 8) return
    const prev = JSON.stringify({ch:this.channels, mode:this.mode, feel:this.feel, rate:this.rate, pm:this.powerMode})
    this.battery       = parseInt(parts[0]) || 0
    this.channels.A.power = Math.round(parseInt(parts[1]) / 2)
    this.channels.B.power = Math.round(parseInt(parts[2]) / 2)
    this.feel          = Math.round(parseInt(parts[3]) / 2)
    this.rate          = Math.round(parseInt(parts[4]) / 2)
    this.mode          = parseInt(parts[5]) || 0
    this.powerMode     = parts[6] === 'H' ? 'H' : 'L'
    this.joined        = parseInt(parts[7]) === 1
    if (parts[8]) this.firmware = parts[8].trim()
    this._broadcastState()
  }

  _send(cmd) {
    if (!this._fd) return
    const buf = Buffer.from(cmd+'\r','ascii')
    fsWrite(this._fd, buf, 0, buf.length, null, err => {
      if (err) console.error(`[${this.id}] write:`, err.message)
    })
  }

  _broadcastState() {
    broadcast({type:'device:state',id:this.id,channels:this.channels,
      mode:this.mode,feel:this.feel,rate:this.rate,powerMode:this.powerMode,
      battery:this.battery,firmware:this.firmware,joined:this.joined})
  }

  setChannel(ch,{power}={}) {
    if (power!==undefined) {
      this.channels[ch].power=Math.max(0,Math.min(99,Math.round(power)))
      this._send(`${ch}${this.channels[ch].power}`)
    }
  }

  setMode(mode) {
    this.mode=Math.max(0,Math.min(ESTIM_MODES.length-1,Math.round(mode)))
    this._send(`M${this.mode}`)
  }

  setFeel(val) {
    this.feel=Math.max(0,Math.min(99,Math.round(val)))
    this._send(`C${this.feel}`)
  }

  setRate(val) {
    this.rate=Math.max(0,Math.min(99,Math.round(val)))
    this._send(`D${this.rate}`)
  }

  setPowerMode(mode) {
    this.powerMode=mode==='H'?'H':'L'
    this._send(this.powerMode)
  }

  setJoined(joined) {
    this.joined=!!joined
    this._send(joined?'J':'U')
  }

  stop() {
    this.channels.A.power=0; this.channels.B.power=0
    this._send('K')  // built-in kill-both command
    this._broadcastState()
  }

  async disconnect() {
    this._reading = false
    if (this._fd) { this._send('K'); await new Promise(r=>setTimeout(r,200)); fsClose(this._fd,()=>{}); this._fd=null }
    this.status='disconnected'
    broadcast({type:'device:status',id:this.id,status:'disconnected'})
  }

  toJSON() {
    return {id:this.id,type:'estim',name:this.name,ttyPath:this.ttyPath,
      status:this.status,channels:this.channels,mode:this.mode,
      feel:this.feel,rate:this.rate,powerMode:this.powerMode,
      battery:this.battery,firmware:this.firmware,joined:this.joined}
  }
}

// ── EoM Device ────────────────────────────────────────────────────────────────
class EomDevice {
  constructor(id, name, ip, port) {
    this.id=id; this.name=name; this.type='eom'
    this.ip=ip||''; this.port=parseInt(port)||80
    this.status='disconnected'
    this._ws=null; this._reconnectTimer=null; this._connectLock=false
    this._readingsTimer=null; this._backoff=10000
    this._motorSpeed=0; this._mode='manual'
    this._readings={ pressure:0, pavg:0, motor:0, arousal:0 }
    this._denialCount=0; this._lastDetectState=null; this._lastMotorLive=0
  }

  async connect() {
    if (this._connectLock || this.status==='connected') return
    console.log(`[${this.id}] EoM connecting to ${this.ip}:${this.port}...`)
    this._connectLock=true; this.status='connecting'
    broadcast({ type:'device:status', id:this.id, status:'connecting' })
    try {
      await new Promise((resolve, reject) => {
        // EomWS: custom WS client that ignores ESP32 firmware protocol violations
        // (RSV bits set, non-UTF-8 text frames) that crash the standard ws library
        const ws = new EomWS().connect(this.ip, this.port, 500)
        let resolved = false
        ws.on('open', () => {
          resolved=true; this._ws=ws; this._connectLock=false; this.status='connected'
          this._everConnected=true  // enable auto-reconnect after first success
          broadcast({ type:'device:status', id:this.id, status:'connected' })
          console.log(`[${this.id}] EoM connected to ${this.ip}:${this.port}`)
          // Only send streamReadings once — do NOT re-send while connected.
          // The ESP32 crashes if it receives streamReadings while already streaming under load.
          // No keepalive needed: EoM streams continuously until the connection drops.
          this._send({ streamReadings:true })
          resolve()
        })
        ws.on('message', (raw, isBinary) => {
          if (isBinary) return  // ignore binary frames
          try {
            const msg=JSON.parse(raw.toString())
            if (msg.readings) {
              if (!this._readingsReceived) {
                console.log(`[${this.id}] First readings from EoM:`, JSON.stringify(msg.readings))
                this._readingsReceived = true
              }
              this._readings=msg.readings
              // Denial detection — count transitions into TRIGGERED/ORGASM_DETECTED
              const _dstate=(msg.readings.detectState||'IDLE')
              this._lastDetectState=_dstate
              // Denial = live motor drops from running (>30) to stopped (0) in auto mode
              const _motorLive = msg.readings.motor||0
              if (this._lastMotorLive>30 && _motorLive===0 && this._mode==='automatic') {
                this._denialCount++
                broadcast({ type:'eom:denial', id:this.id, count:this._denialCount })
              }
              this._lastMotorLive=_motorLive
              // Rate-limit browser broadcasts to 10Hz — EoM sends up to 50Hz in auto mode
              // which floods the browser and locks up the UI
              if (!this._readingsThrottle) {
                this._readingsThrottle = setTimeout(() => {
                  this._readingsThrottle = null
                  broadcast({ type:'eom:readings', id:this.id, readings:this._readings })
                }, 100)
              }
            }
            if (msg.configList) {
              this._config=msg.configList
              broadcast({ type:'eom:config', id:this.id, config:msg.configList })
            }
            if (msg.mode!==undefined) { this._mode=msg.mode; broadcast({ type:'device:state', id:this.id, ...this.toJSON() }) }
          } catch {}
        })
        ws.on('error', err => {
          console.error(`[${this.id}] EoM ws error:`, err.message)
          if (!resolved) { resolved=true; this._connectLock=false; reject(err) }
          // After connect, log but don't crash — ws 'close' event will handle reconnect if needed
        })
        ws.on('close', () => {
          if (this._readingsThrottle) { clearTimeout(this._readingsThrottle); this._readingsThrottle=null }
          this._readingsReceived = false
          this._ws=null
          if (this.status==='connected') {
            this.status='disconnected'
            broadcast({ type:'device:status', id:this.id, status:'disconnected' })
            console.log(`[${this.id}] EoM disconnected — retrying in 10s`)
            this._scheduleReconnect()
          }
        })
      })
    } catch(err) {
      console.error(`[${this.id}] connect error:`, err.message)
      this.status='error'; this._connectLock=false
      broadcast({ type:'device:status', id:this.id, status:'error', error:err.message })
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return
    if (!this._everConnected) return  // Never auto-retry on initial failure — user must click Connect
    // Wait 30s before reconnecting — gives ESP32 time to reboot and free zombie connections
    console.log(`[${this.id}] EoM reconnecting in 30s...`)
    // No auto-reconnect — user must click Connect
  }

  _send(obj) { if (this._ws && this._ws.readyState===1) this._ws.send(JSON.stringify(obj)) }

  setMotor(pct) {
    pct=Math.max(0,Math.min(100,Math.round(pct)))
    this._motorSpeed=pct
    broadcast({ type:'device:state', id:this.id, ...this.toJSON() })
    // Throttle commands to EoM — ESP32 has no buffer and crashes on rapid-fire commands
    if (this._motorThrottle) return
    const raw=Math.round(pct*255/100)
    this._send({ setMotor: raw })
    this._motorThrottle=setTimeout(()=>{
      this._motorThrottle=null
      // Send final value in case more changes came in during throttle window
      const finalRaw=Math.round(this._motorSpeed*255/100)
      this._send({ setMotor: finalRaw })
    }, 300)
  }

  setMode(mode) {
    if (mode!=='automatic'&&mode!=='manual') return
    this._mode=mode
    broadcast({ type:'device:state', id:this.id, ...this.toJSON() })
    if (this._modeThrottle) return
    this._send({ setMode:mode })
    this._modeThrottle=setTimeout(()=>{
      this._modeThrottle=null
      this._send({ setMode:this._mode })
    }, 500)
  }

  setConfig(changes) {
    this._config={ ...(this._config||{}), ...changes }
    broadcast({ type:'eom:config', id:this.id, config:this._config })
    if (this._cfgThrottle) { this._cfgPending=changes; return }
    this._send({ configSet:changes })
    this._cfgThrottle=setTimeout(()=>{
      this._cfgThrottle=null
      if (this._cfgPending) { const p=this._cfgPending; this._cfgPending=null; this._send({ configSet:p }) }
    }, 500)
  }

  refreshConfig() { this._send({ configList:null }) }

  stop() { this.setMotor(0) }
  resetDenials() { this._denialCount=0; broadcast({ type:'eom:denial', id:this.id, count:0 }) }

  async disconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer=null }
    if (this._readingsTimer) { clearInterval(this._readingsTimer); this._readingsTimer=null }
    if (this._ws) { try{this._ws.close()}catch{}; this._ws=null }
    this.status='disconnected'
    broadcast({ type:'device:status', id:this.id, status:'disconnected' })
  }

  toJSON() {
    return { id:this.id, type:'eom', name:this.name, ip:this.ip, port:this.port,
             status:this.status, motorSpeed:this._motorSpeed, mode:this._mode,
             readings:this._readings, config:this._config||null, denialCount:this._denialCount }
  }
}

// ── Camera device (RTSP via go2rtc) ──────────────────────────────────────────
class CameraDevice {
  constructor(id, name, ip, username, password, streamPath, hasPTZ, ptzProfileToken, ptzServiceUrl) {
    this.id=id; this.name=name; this.type='camera'
    this.ip=ip; this.username=username; this.password=password
    this.streamPath=streamPath||'h264Preview_01_sub'
    this.hasPTZ=!!hasPTZ; this.ptzProfileToken=ptzProfileToken||null; this.ptzServiceUrl=ptzServiceUrl||null
    this.status='idle'
  }
  get rtspUrl() { return `rtsp://${this.username}:${this.password}@${this.ip}:554/${this.streamPath}` }
  get streamKey() { return this.id.replace(/[^a-z0-9]/gi,'_') }
  toJSON() { return { id:this.id, type:'camera', name:this.name, ip:this.ip, username:this.username, streamPath:this.streamPath, hasPTZ:this.hasPTZ, ptzProfileToken:this.ptzProfileToken, ptzServiceUrl:this.ptzServiceUrl, status:this.status, streamKey:this.streamKey } }
}

// ── Philips Hue Bridge ────────────────────────────────────────────────────────
class HueBridge {
  constructor(id, name, ip, token, selectedLights, selectedGroups, selectedScenes) {
    this.id=id; this.name=name; this.type='hue'
    this.ip=ip||''; this.token=token||''
    this.selectedLights=selectedLights||[]
    this.selectedGroups=selectedGroups||[]
    this.selectedScenes=selectedScenes||[]
    this.status='disconnected'
    this._lights={}; this._groups={}; this._scenes={}; this._bridgeName=''
    this._activeSceneByGroup={}
  }

  async connect() {
    if (!this.ip||!this.token) {
      this.status='error'
      broadcast({type:'device:status',id:this.id,status:'error',error:'Bridge not paired'})
      return
    }
    this.status='connecting'
    broadcast({type:'device:status',id:this.id,status:'connecting'})
    try {
      await this.loadInventory()
      this.status='connected'
      broadcast({type:'device:status',id:this.id,status:'connected'})
      broadcast({type:'hue:inventory',id:this.id,...this._inventory()})
      console.log(`[${this.id}] Hue bridge connected: ${this._bridgeName}`)
    } catch(err) {
      this.status='error'
      broadcast({type:'device:status',id:this.id,status:'error',error:err.message})
      console.error(`[${this.id}] Hue connect error:`,err.message)
    }
  }

  async loadInventory() {
    const base=`http://${this.ip}/api/${this.token}`
    const [cfgRes,lightsRes,groupsRes,scenesRes] = await Promise.all([
      fetch(`${base}/config`), fetch(`${base}/lights`),
      fetch(`${base}/groups`), fetch(`${base}/scenes`)
    ])
    if (!cfgRes.ok) throw new Error(`Bridge returned ${cfgRes.status}`)
    const cfg=await cfgRes.json()
    this._bridgeName=cfg.name||'Hue Bridge'
    this._lights=await lightsRes.json()
    this._groups=await groupsRes.json()
    this._scenes=await scenesRes.json()
  }

  _inventory() { return {lights:this._lights,groups:this._groups,scenes:this._scenes,bridgeName:this._bridgeName} }

  async _put(path,body) {
    const res=await fetch(`http://${this.ip}/api/${this.token}${path}`,{
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    })
    return res.json()
  }

  setLight(lightId,params) {
    const state={}
    if (params.on!==undefined) state.on=params.on
    if (params.bri!==undefined) state.bri=Math.round(Math.max(1,Math.min(254,params.bri*254/100)))
    if (params.hue!==undefined) state.hue=params.hue
    if (params.sat!==undefined) state.sat=params.sat
    if (params.ct!==undefined) state.ct=params.ct
    if (params.transitiontime!==undefined) state.transitiontime=params.transitiontime
    if (this._lights[lightId]) Object.assign(this._lights[lightId].state,state)
    broadcast({type:'hue:light',id:this.id,lightId,state:this._lights[lightId]?.state})
    this._put(`/lights/${lightId}/state`,state).catch(err=>console.error(`[${this.id}] Hue setLight:`,err.message))
  }

  setGroup(groupId,params) {
    const action={}
    if (params.on!==undefined) action.on=params.on
    if (params.bri!==undefined) action.bri=Math.round(Math.max(1,Math.min(254,params.bri*254/100)))
    if (params.hue!==undefined) action.hue=params.hue
    if (params.sat!==undefined) action.sat=params.sat
    if (params.ct!==undefined) action.ct=params.ct
    if (params.transitiontime!==undefined) action.transitiontime=params.transitiontime
    if (this._groups[groupId]) Object.assign(this._groups[groupId].action,action)
    if (params.on===false) delete this._activeSceneByGroup[groupId]
    broadcast({type:'hue:group',id:this.id,groupId,action:this._groups[groupId]?.action})
    this._put(`/groups/${groupId}/action`,action).catch(err=>console.error(`[${this.id}] Hue setGroup:`,err.message))
  }

  activateScene(sceneId) {
    const scene=this._scenes[sceneId]
    const groupId=scene?.group||'0'
    this._activeSceneByGroup[groupId]=sceneId
    if (this._groups[groupId]) Object.assign(this._groups[groupId].action||(this._groups[groupId].action={}),{on:true})
    broadcast({type:'hue:scene',id:this.id,sceneId,groupId})
    this._put(`/groups/${groupId}/action`,{scene:sceneId}).catch(err=>console.error(`[${this.id}] Hue activateScene:`,err.message))
  }

  async disconnect() {
    this.status='disconnected'
    broadcast({type:'device:status',id:this.id,status:'disconnected'})
  }

  toJSON() {
    return {id:this.id,type:'hue',name:this.name,ip:this.ip,status:this.status,
            bridgeName:this._bridgeName,selectedLights:this.selectedLights,
            selectedGroups:this.selectedGroups,selectedScenes:this.selectedScenes,
            lights:this._lights,groups:this._groups,scenes:this._scenes}
  }
}

function rebuildGo2rtcConfig() {
  const cameras = Object.values(devices).filter(d=>d.type==='camera')
  const streams = {}
  for (const cam of cameras) { streams[cam.streamKey] = [cam.rtspUrl, `ffmpeg:${cam.rtspUrl}#audio=opus`]; cam.status='connecting'; broadcast({type:'device:status',id:cam.id,status:'connecting'}) }
  const streamLines = Object.entries(streams).map(([k,v]) => Array.isArray(v)
    ? `  ${k}:\n    - ${v[0]}\n    - ${v[1]}`
    : `  ${k}: ${v}`).join('\n') || '  # no cameras configured'
  const yaml = `api:\n  listen: :1984\n  origin: "*"\n\nstreams:\n${streamLines}\n\nlog:\n  level: info\n`
  writeFileSync(join(__dirname,'..','go2rtc.yaml'), yaml)
  exec('pm2 restart go2rtc', err => { if(err) console.error('[go2rtc] restart error:',err.message) })
  console.log(`[go2rtc] config rebuilt with ${cameras.length} camera(s)`)
  setTimeout(checkCameraStatus, 8000)
}

async function checkCameraStatus() {
  const cameras = Object.values(devices).filter(d=>d.type==='camera')
  if (!cameras.length) return
  try {
    const r = await fetch('http://127.0.0.1:1984/api/streams', { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return
    const streams = await r.json()
    for (const cam of cameras) {
      const s = streams[cam.streamKey]
      const newStatus = Array.isArray(s?.producers) && s.producers.length > 0 ? 'connected' : 'error'
      if (cam.status !== newStatus) {
        cam.status = newStatus
        broadcast({ type:'device:status', id:cam.id, status:newStatus })
      }
    }
  } catch {}
}

setInterval(checkCameraStatus, 12000)

function createDevice(cfg) {
  if (cfg.type==='coyote')     return new CoyoteDevice(cfg.id,cfg.name,cfg.mac,cfg.bleName)
  if (cfg.type==='pawprints') return new PawPrintsDevice(cfg.id,cfg.name,cfg.mac,cfg.bleName)
  if (cfg.type==='eom')    return new EomDevice(cfg.id,cfg.name,cfg.ip,cfg.port)
  if (cfg.type==='nimble') return new NimbleDevice(cfg.id,cfg.name,cfg.ttyPath)
  if (cfg.type==='estim')  return new EstimDevice(cfg.id,cfg.name,cfg.ttyPath)
  if (cfg.type==='camera') return new CameraDevice(cfg.id,cfg.name,cfg.ip,cfg.username,cfg.password,cfg.streamPath,cfg.hasPTZ,cfg.ptzProfileToken,cfg.ptzServiceUrl)
  if (cfg.type==='hue')    return new HueBridge(cfg.id,cfg.name,cfg.ip,cfg.token,cfg.selectedLights,cfg.selectedGroups,cfg.selectedScenes)
  throw new Error(`Unknown type: ${cfg.type}`)
}
for (const d of config.devices) {
  try {
    const dev = createDevice(d)
    devices[d.id] = dev
    if (dev.type === 'coyote') setTimeout(() => dev.connect().catch(() => {}), 3000)
    if (dev.type === 'hue' && dev.token) setTimeout(() => dev.connect().catch(() => {}), 3000)
  } catch {}
}
// Always rebuild go2rtc config on startup so it stays in sync with saved cameras
rebuildGo2rtcConfig()

let scanResults=[], isScanning=false
async function doScan() {
  if (isScanning) return
  isScanning=true; scanResults=[]
  broadcast({ type:'scan:start' })
  try {
    const adp=await getAdapter()
    await adp.startDiscovery()
    const seen=new Set()
    const poll=setInterval(async()=>{
      try {
        const addrs=await adp.devices()
        for (const addr of addrs) {
          if (seen.has(addr)) continue; seen.add(addr)
          try {
            const d=await adp.getDevice(addr)
            const name=await d.getName().catch(()=>'')||'(unknown)'
            const isCoyote=name.startsWith('47L121')
            const isPawPrints=name.startsWith('47L120')
            const rssi=await d.getRSSI().catch(()=>0)
            const result={mac:addr,name,rssi,isCoyote,isPawPrints}
            scanResults.push(result)
            broadcast({ type:'scan:found', device:result })
          } catch {}
        }
      } catch {}
    },500)
    setTimeout(async()=>{
      clearInterval(poll); await adp.stopDiscovery().catch(()=>{})
      isScanning=false; broadcast({ type:'scan:done', results:scanResults })
    },10000)
  } catch(e) {
    isScanning=false; broadcast({ type:'scan:done', results:[] })
    console.error('Scan error:',e.message)
  }
}

// ── Express + Session ─────────────────────────────────────────────────────────
const app = express()

const sessionMW = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: join(__dirname, 'sessions'), ttl: 7 * 24 * 3600, logFn: ()=>{} }),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
})
app.use(sessionMW)
app.use(express.json())

// Auth guard — skips when auth disabled, skips /login and /api/auth/* always
function requireAuth(req, res, next) {
  if (!config.auth?.enabled) return next()
  if (req.session?.authed) return next()
  if (req.path === '/login' || req.path === '/setup.html' || req.path.startsWith('/api/auth')) return next()
  // WiFi/status endpoints always accessible — needed during AP setup mode
  if (req.path === '/api/status' || req.path === '/api/wifi/ap-status' || req.path === '/api/wifi/scan' || req.path === '/api/wifi/connect') return next()
  if (req.headers.accept?.includes('application/json')) return res.status(401).json({ error: 'Unauthorized' })
  res.redirect('/login')
}
// Captive portal — in AP setup mode, redirect probe URLs to the setup page
// iOS/Android send HTTP probes to external domains; DNS spoofing returns our IP,
// port 80 iptables redirects to 3000, and this middleware sends them to /setup.html
app.use((req, res, next) => {
  if (!existsSync(AP_FLAG)) return next()
  if (req.path === '/setup.html' ||
      req.path.startsWith('/api/wifi') ||
      req.path.startsWith('/api/status') ||
      req.path === '/') return next()
  res.redirect('http://10.42.0.1/setup.html')
})

app.use(requireAuth)

// Admin-only guard — used on config routes
function requireAdmin(req, res, next) {
  if (!config.auth?.enabled) return next()
  if (req.session?.role === 'admin') return next()
  res.status(403).json({ error: 'Admin access required' })
}

// ── go2rtc proxy — forwards /api/go2rtc/* to the local go2rtc instance ───────
const go2rtcProxy = createProxyMiddleware({
  target: 'http://127.0.0.1:1984',
  changeOrigin: true,
  ws: false,   // WebSocket upgrade handled manually below — ws:true fights with the main WS server
  pathRewrite: { '^/api/go2rtc': '' },
  on: {
    error: (err, req, res) => { try { if (typeof res?.status === 'function') res.status(502).json({ error: 'Camera service unavailable' }) } catch {} },
    proxyRes: (proxyRes, req) => {
      // Disable Cloudflare / nginx buffering for live streaming endpoints.
      // Without this, Cloudflare buffers the infinite MP4 stream indefinitely
      // and the browser never receives any bytes through the tunnel.
      if (req.url.includes('stream.mp4') || req.url.includes('stream.ts') || req.url.includes('stream.mjpeg')) {
        proxyRes.headers['x-accel-buffering'] = 'no'
        proxyRes.headers['cache-control'] = 'no-cache, no-store'
      }
    }
  }
})
app.use('/api/go2rtc', go2rtcProxy)

app.use(express.static(join(__dirname, 'public'), { etag:false, lastModified:false, setHeaders: res => res.set('Cache-Control','no-store') }))
app.use('/icons', express.static(join(__dirname, 'icons'), { etag:false, lastModified:false, setHeaders: res => res.set('Cache-Control','no-store') }))

// ── Login page ────────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EdgeController — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#161616;border:1px solid #222;border-radius:12px;padding:32px 28px;width:320px}
.logo{text-align:center;margin-bottom:26px}
.logo-icon{font-size:28px;margin-bottom:6px}
.logo-title{font-size:17px;font-weight:700;letter-spacing:-.3px}
.logo-sub{font-size:10px;color:#333;margin-top:3px;text-transform:uppercase;letter-spacing:1px}
label{display:block;font-size:10px;color:#555;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
input{width:100%;background:#111;border:1px solid #2a2a2a;color:#e0e0e0;padding:9px 11px;border-radius:7px;font-size:14px;margin-bottom:14px;outline:none;transition:border-color .15s}
input:focus{border-color:#4fc3f7}
button{width:100%;background:#4fc3f7;color:#000;font-size:13px;font-weight:700;padding:10px;border:none;border-radius:7px;cursor:pointer;margin-top:2px;letter-spacing:.2px}
button:hover{background:#29b6f6}
.err{background:#450a0a;border:1px solid #7f1d1d;color:#fca5a5;padding:8px 11px;border-radius:6px;font-size:12px;margin-bottom:14px;display:none}
</style></head><body>
<div class="box">
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div class="logo-title">EdgeController</div>
    <div class="logo-sub">Secure Login</div>
  </div>
  <div class="err" id="err"></div>
  <form onsubmit="go(event)">
    <label>Username</label>
    <input type="text" id="u" autocomplete="username" autofocus/>
    <label>Password</label>
    <input type="password" id="p" autocomplete="current-password"/>
    <button type="submit">Sign in →</button>
  </form>
</div>
<script>
async function go(e){
  e.preventDefault()
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})})
  if(r.ok){location.href='/'}
  else{const j=await r.json();const el=document.getElementById('err');el.textContent=j.error||'Login failed';el.style.display='block'}
}
</script></body></html>`

app.get('/login', (req, res) => {
  if (!config.auth?.enabled || req.session?.authed) return res.redirect('/')
  res.send(LOGIN_HTML)
})

// ── Auth API ──────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!config.auth?.enabled) return res.json({ ok: true, role: 'admin' })
  const pw = password || ''
  const adm = config.auth.admin
  const usr = config.auth.user
  if (adm?.username && username === adm.username && adm.passwordHash && bcrypt.compareSync(pw, adm.passwordHash)) {
    req.session.authed = true; req.session.role = 'admin'
    return req.session.save(() => res.json({ ok: true, role: 'admin' }))
  }
  if (usr?.username && username === usr.username && usr.passwordHash && bcrypt.compareSync(pw, usr.passwordHash)) {
    req.session.authed = true; req.session.role = 'user'
    return req.session.save(() => res.json({ ok: true, role: 'user' }))
  }
  res.status(401).json({ error: 'Invalid credentials' })
})

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

// Save credentials + enable/disable auth (admin only)
app.put('/api/auth', requireAdmin, (req, res) => {
  const { adminUsername, adminPassword, userUsername, userPassword, enabled } = req.body || {}
  if (adminPassword !== undefined) {
    if (!adminUsername) return res.status(400).json({ error: 'Admin username required' })
    config.auth.admin = { username: adminUsername, passwordHash: bcrypt.hashSync(adminPassword, 10) }
  }
  if (userPassword !== undefined) {
    if (!userUsername) return res.status(400).json({ error: 'User username required' })
    config.auth.user = { username: userUsername, passwordHash: userPassword ? bcrypt.hashSync(userPassword, 10) : '' }
  }
  if (typeof enabled === 'boolean') {
    if (enabled && !config.auth.admin?.passwordHash) return res.status(400).json({ error: 'Set admin password before enabling' })
    config.auth.enabled = enabled
  }
  saveConfig(config)
  res.json({ ok: true })
})

// ── Tunnel API ────────────────────────────────────────────────────────────────
app.put('/api/tunnel', requireAdmin, (req, res) => {
  const { token, hostname, enabled } = req.body || {}
  if (token    !== undefined) config.tunnel.token    = token
  if (hostname !== undefined) config.tunnel.hostname = hostname
  if (typeof enabled === 'boolean') {
    config.tunnel.enabled = enabled
    if (enabled)  tunnelStart()
    else          tunnelStop()
  }
  saveConfig(config)
  res.json({ ok: true, tunnel: { enabled: config.tunnel.enabled, hostname: config.tunnel.hostname, hasToken: !!config.tunnel.token, status: tunnelStatus } })
})

app.get('/api/tunnel/status', requireAdmin, (req, res) => {
  res.json({ status: tunnelStatus, hostname: config.tunnel?.hostname || '', enabled: config.tunnel?.enabled || false, hasToken: !!config.tunnel?.token })
})

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = createServer(app)
const wss    = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  sessionMW(request, {}, () => {
    if (config.auth?.enabled && !request.session?.authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    // Route camera WebSocket upgrades to go2rtc, everything else to the main WS server
    if (request.url.startsWith('/api/go2rtc/')) {
      request.url = request.url.replace('/api/go2rtc', '')
      go2rtcProxy.upgrade(request, socket, head)
    } else {
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
    }
  })
})

function safeConfig() {
  return {
    boxId:   config.boxId,
    version: APP_VERSION,
    auth:    { enabled: config.auth?.enabled || false, adminUsername: config.auth?.admin?.username || '', userUsername: config.auth?.user?.username || '', hasUser: !!(config.auth?.user?.passwordHash) },
    tunnel:  { enabled: config.tunnel?.enabled || false, hostname: config.tunnel?.hostname || '', hasToken: !!config.tunnel?.token, status: tunnelStatus }
  }
}

// Strip frame data from audio waveforms for WS broadcast — they're huge (MB each)
// The browser fetches full audio data via /api/waveforms REST endpoint instead
function waveformsMeta() {
  return {
    builtin: BUILTIN_WAVEFORMS,
    custom: waveformStore.custom.map(w =>
      w.type === 'audio' ? { id:w.id, name:w.name, type:'audio', frames:w.frames?.length||0 } : w
    )
  }
}

wss.on('connection', (ws, request) => {
  ws.role = request.session?.role || (config.auth?.enabled ? 'user' : 'admin')
  clients.add(ws)
  ws.send(JSON.stringify({ type:'state', role:ws.role, devices:Object.values(devices).map(d=>d.toJSON()), groups:config.groups||[], config:safeConfig(), waveforms:waveformsMeta(), deck:{ status: streamDeck ? 'connected' : 'disconnected', name: streamDeck?.deck?.PRODUCT_NAME||null } }))
  ws.on('close', () => clients.delete(ws))
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw)
      const dev = devices[msg.deviceId]
      if (msg.type==='device:setChannel' && dev?.setChannel) dev.setChannel(msg.channel, msg.params)
      if (msg.type==='device:stop' && dev) {
        if (dev.type==='eom') dev.stop()
        else { dev.setChannel('A',{intensity:0}); dev.setChannel('B',{intensity:0}) }
      }
      if (msg.type==='eom:setMotor'      && dev?.type==='eom') { console.log(`[ws] eom:setMotor speed=${msg.speed} devId=${msg.deviceId}`); dev.setMotor(msg.speed) }
      if (msg.type==='eom:setMode'       && dev?.type==='eom') dev.setMode(msg.mode)
      if (msg.type==='eom:setConfig'     && dev?.type==='eom') dev.setConfig(msg.changes)
      if (msg.type==='eom:refreshConfig' && dev?.type==='eom') dev.refreshConfig()
      if (msg.type==='eom:resetDenials'  && dev?.type==='eom') dev.resetDenials()
      if (msg.type==='eom:restartStream' && dev?.type==='eom') {
        dev._send({ streamReadings:true })
        console.log(`[${dev.id}] streamReadings restarted by client`)
      }
      if (msg.type==='nimble:setOscillation' && dev?.type==='nimble') dev.setOscillation(msg.params)
      if (msg.type==='nimble:setForce'       && dev?.type==='nimble') dev.setForce(msg.force)
      if (msg.type==='nimble:setPosition'    && dev?.type==='nimble') dev.setPosition(msg.position)
      if (msg.type==='nimble:stop'           && dev?.type==='nimble') dev.stop()
      if (msg.type==='estim:setChannel'  && dev?.type==='estim') dev.setChannel(msg.channel,msg.params)
      if (msg.type==='estim:setMode'     && dev?.type==='estim') dev.setMode(msg.mode)
      if (msg.type==='estim:setFeel'     && dev?.type==='estim') dev.setFeel(msg.value)
      if (msg.type==='estim:setRate'     && dev?.type==='estim') dev.setRate(msg.value)
      if (msg.type==='estim:setPowerMode'&& dev?.type==='estim') dev.setPowerMode(msg.mode)
      if (msg.type==='estim:setJoined'   && dev?.type==='estim') dev.setJoined(msg.joined)
      if (msg.type==='estim:stop'        && dev?.type==='estim') dev.stop()
      // Group commands — apply to all connected estim devices
      if (msg.type==='estim:group:setMode') {
        Object.values(devices).filter(d=>d.type==='estim'&&d.status==='connected').forEach(d=>d.setMode(msg.mode))
      }
      if (msg.type==='estim:group:setFeel') {
        Object.values(devices).filter(d=>d.type==='estim'&&d.status==='connected').forEach(d=>d.setFeel(msg.value))
      }
      if (msg.type==='estim:group:setRate') {
        Object.values(devices).filter(d=>d.type==='estim'&&d.status==='connected').forEach(d=>d.setRate(msg.value))
      }
      if (msg.type==='estim:group:setPowerMode') {
        Object.values(devices).filter(d=>d.type==='estim'&&d.status==='connected').forEach(d=>d.setPowerMode(msg.mode))
      }
      if (msg.type==='estim:group:stop') {
        Object.values(devices).filter(d=>d.type==='estim').forEach(d=>d.stop())
      }
      if (msg.type==='stopAll') {
        // Kill all running macros first
        Object.values(macroRunners).forEach(r => r.stop())
        // Zero all devices
        for (const d of Object.values(devices)) {
          if (d.type==='eom') d.stop()
          else if (d.type==='nimble') d.stop()
          else if (d.type==='estim') d.stop()
          else if (d.setChannel) { d.setChannel('A',{intensity:0}); d.setChannel('B',{intensity:0}) }
        }
      }
      // group:set — apply intensity/waveform to every individual channel in the group
      if (msg.type==='group:set') {
        const grp=(config.groups||[]).find(g=>g.id===msg.groupId)
        if(grp) for(const {deviceId,channel} of grp.channels||[]){
          const dev=devices[deviceId]; if(dev?.setChannel) dev.setChannel(channel,msg.params)
        }
      }
      if (msg.type==='group:stop') {
        const grp=(config.groups||[]).find(g=>g.id===msg.groupId)
        if(grp) for(const {deviceId,channel} of grp.channels||[]){
          const dev=devices[deviceId]; if(dev?.setChannel) dev.setChannel(channel,{intensity:0})
        }
      }
      if (msg.type==='deck:connect') {
        if (!streamDeck) initStreamDeck()
        else broadcast({ type:'deck:status', status:'connected', name:streamDeck.deck?.PRODUCT_NAME||null })
      }
      if (msg.type==='deck:disconnect') disconnectStreamDeck()
    } catch {}
  })
})

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/status',  (req,res) => res.json({ ok:true, boxId:config.boxId, version:APP_VERSION, uptime:process.uptime(), deviceCount:Object.keys(devices).length }))
app.get('/api/devices', (req,res) => res.json(Object.values(devices).map(d=>d.toJSON())))
app.post('/api/scan',   (req,res) => { doScan(); res.json({scanning:true}) })
app.get('/api/serial-ports', async (req,res) => {
  try { const ports=await SerialPort.list(); res.json(ports) }
  catch(e){ res.status(500).json({error:e.message}) }
})
app.get('/api/scan/results', (req,res) => res.json({scanning:isScanning,results:scanResults}))

app.post('/api/devices', async (req,res) => {
  const {type,name,mac,bleName,ip,port,ttyPath,username,password,streamPath,token,hasPTZ,ptzProfileToken,ptzServiceUrl} = req.body
  if (!type||!name) return res.status(400).json({error:'type and name required'})
  const id=`${type}-${Date.now()}`, cfg={id,type,name,mac,bleName,ip,port,ttyPath,username,password,streamPath,token,hasPTZ,ptzProfileToken,ptzServiceUrl}
  try {
    const dev=createDevice(cfg); devices[id]=dev; config.devices.push(cfg); saveConfig(config)
    if (type==='camera') rebuildGo2rtcConfig()
    res.json(dev.toJSON()); broadcast({type:'device:added',device:dev.toJSON()})
    // User must click Connect manually (not applicable for camera)
  } catch(err) { res.status(400).json({error:err.message}) }
})

app.patch('/api/devices/:id', async (req,res) => {
  const dev=devices[req.params.id]; if (!dev) return res.status(404).json({error:'not found'})
  const {name,ip,port,ttyPath,username,password,streamPath,hasPTZ,ptzProfileToken,ptzServiceUrl}=req.body
  if (name) dev.name=name
  if (dev.type==='eom') {
    if (ip)   dev.ip=ip
    if (port) dev.port=parseInt(port)
  }
  if ((dev.type==='nimble'||dev.type==='estim') && ttyPath) dev.ttyPath=ttyPath
  if (dev.type==='camera') {
    if (ip)                  dev.ip=ip
    if (username)            dev.username=username
    if (password)            dev.password=password
    if (streamPath)          dev.streamPath=streamPath
    if (hasPTZ !== undefined) dev.hasPTZ=!!hasPTZ
    if (ptzProfileToken)     dev.ptzProfileToken=ptzProfileToken
    if (ptzServiceUrl)       dev.ptzServiceUrl=ptzServiceUrl
  }
  if (dev.type==='hue') { if (ip) dev.ip=ip }
  const cfg=config.devices.find(d=>d.id===req.params.id)
  if (cfg) {
    if (name) cfg.name=name
    if (dev.type==='eom') { if (ip) cfg.ip=ip; if (port) cfg.port=parseInt(port) }
    if ((dev.type==='nimble'||dev.type==='estim') && ttyPath) cfg.ttyPath=ttyPath
    if (dev.type==='camera') {
      if (ip)                  cfg.ip=ip
      if (username)            cfg.username=username
      if (password)            cfg.password=password
      if (streamPath)          cfg.streamPath=streamPath
      if (hasPTZ !== undefined) cfg.hasPTZ=!!hasPTZ
      if (ptzProfileToken)     cfg.ptzProfileToken=ptzProfileToken
      if (ptzServiceUrl)       cfg.ptzServiceUrl=ptzServiceUrl
    }
    if (dev.type==='hue') { if (ip) cfg.ip=ip }
    saveConfig(config)
  }
  if (dev.type==='camera') rebuildGo2rtcConfig()
  broadcast({type:'device:updated',device:dev.toJSON()})
  res.json(dev.toJSON())
})

app.delete('/api/devices/:id', async (req,res) => {
  const dev=devices[req.params.id]; if (!dev) return res.status(404).json({error:'not found'})
  try{await dev.disconnect()}catch{}
  const wasCamera = dev.type==='camera'
  delete devices[req.params.id]; config.devices=config.devices.filter(d=>d.id!==req.params.id); saveConfig(config)
  if (wasCamera) rebuildGo2rtcConfig()
  broadcast({type:'device:removed',id:req.params.id}); res.json({ok:true})
})

app.post('/api/devices/:id/connect', (req,res) => {
  const dev=devices[req.params.id]; if (!dev) return res.status(404).json({error:'not found'})
  dev.connect().catch(e=>console.error(`[${dev.id}]`,e.message)); res.json({ok:true})
})

app.post('/api/devices/:id/disconnect', async (req,res) => {
  const dev=devices[req.params.id]; if (!dev) return res.status(404).json({error:'not found'})
  try{await dev.disconnect();res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}
})

// ── ONVIF camera scan ─────────────────────────────────────────────────────────
async function getOnvifDeviceInfo(xaddr) {
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <tds:GetDeviceInformation xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>
  </s:Body>
</s:Envelope>`
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    const r = await fetch(xaddr, { method:'POST', headers:{'Content-Type':'application/soap+xml'}, body:soap, signal:ctrl.signal })
    clearTimeout(t)
    const txt = await r.text()
    const mfr = txt.match(/<[^:>]*:?Manufacturer>([^<]+)<\/[^:>]*:?Manufacturer>/)?.[1]?.trim()
    const mdl = txt.match(/<[^:>]*:?Model>([^<]+)<\/[^:>]*:?Model>/)?.[1]?.trim()
    return (mfr || mdl) ? { manufacturer: mfr||'', model: mdl||'' } : null
  } catch { return null }
}

async function doOnvifScan(broadcast) {
  const PROBE = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
            xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
            xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:onvif-scan-1</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
  </e:Body>
</e:Envelope>`

  const seen = new Set()
  const sock = dgram.createSocket({ type:'udp4', reuseAddr:true })
  broadcast({ type:'camera:scan:start' })

  await new Promise((resolve) => {
    sock.on('message', async (msg) => {
      const txt = msg.toString()
      const xaddrMatch = txt.match(/<[^:>]*:?XAddrs>([^<]+)<\/[^:>]*:?XAddrs>/)
      if (!xaddrMatch) return
      const xaddr = xaddrMatch[1].trim().split(/\s+/)[0]
      if (!xaddr || seen.has(xaddr)) return
      seen.add(xaddr)
      const ipMatch = xaddr.match(/https?:\/\/([\d.]+)/)
      const ip = ipMatch?.[1]
      if (!ip) return
      const info = await getOnvifDeviceInfo(xaddr)
      const name = info ? `${info.manufacturer} ${info.model}`.trim() : `Camera ${ip}`
      broadcast({ type:'camera:scan:found', ip, name, xaddr })
    })
    sock.bind(0, () => {
      sock.setBroadcast(true)
      sock.setMulticastTTL(4)
      const buf = Buffer.from(PROBE)
      sock.send(buf, 0, buf.length, 3702, '239.255.255.250')
      setTimeout(resolve, 4000)
    })
  })
  sock.close()
  broadcast({ type:'camera:scan:done', count: seen.size })
}

app.post('/api/cameras/scan', requireAuth, (req, res) => {
  res.json({ ok: true })
  doOnvifScan(msg => {
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(JSON.stringify(msg))
  })
})

// ── ONVIF device discovery (features, profiles, PTZ) ─────────────────────────
function wsSecHeader(user, pass) {
  const nonce = randomBytes(16)
  const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const digest = createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)]))
    .digest('base64')
  const nonce64 = nonce.toString('base64')
  return `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" s:mustUnderstand="false"><wsse:UsernameToken><wsse:Username>${user}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce64}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`
}

async function onvifPost(url, body, user, pass, ms=4000) {
  const sec = (user && pass) ? wsSecHeader(user, pass) : ''
  const soap = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><s:Header>${sec}</s:Header><s:Body>${body}</s:Body></s:Envelope>`
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), ms)
  try {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/soap+xml;charset=UTF-8'}, body:soap, signal:ctrl.signal })
    clearTimeout(t); return await r.text()
  } finally { clearTimeout(t) }
}

function xmlFirst(txt, tag) {
  return txt.match(new RegExp(`<[^:>]*:?${tag}(?:\\s[^>]*)?>([^<]+)<\\/[^:>]*:?${tag}>`))?.[1]?.trim()
}

async function onvifDiscoverDevice(ip, user, pass) {
  // Try common ONVIF device service URLs in order
  const candidates = [
    `http://${ip}:8000/onvif/device_service`,
    `http://${ip}/onvif/device_service`,
    `http://${ip}:8080/onvif/device_service`,
    `http://${ip}/onvif/device`,
    `http://${ip}:8899/onvif/device_service`,
  ]
  const probe = `<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>All</tds:Category></tds:GetCapabilities>`
  let capXml = null, deviceUrl = null
  for (const url of candidates) {
    try {
      const xml = await onvifPost(url, probe, user, pass, 3000)
      if (xml && !xml.includes('<s:Fault>') && xml.includes('Capabilities')) { capXml = xml; deviceUrl = url; break }
      if (xml && xml.includes('Capabilities')) { capXml = xml; deviceUrl = url; break }
    } catch {}
  }
  if (!capXml) throw new Error(`ONVIF not reachable at ${ip} (tried ports 80/8000/8080/8899)`)

  // Derive base URL from the working device service URL so all services use the same port
  const baseUrl = new URL(deviceUrl).origin

  const mediaUrlMatch = capXml.match(/<[^:>\/]*:?Media\b[^>]*>[\s\S]*?<[^:>\/]*:?XAddr>([^<]+)<\/[^:>\/]*:?XAddr>/)
  const ptzUrlMatch   = capXml.match(/<[^:>\/]*:?PTZ\b[^>]*>[\s\S]*?<[^:>\/]*:?XAddr>([^<]+)<\/[^:>\/]*:?XAddr>/)
  const mediaUrl = mediaUrlMatch?.[1]?.trim() || `${baseUrl}/onvif/media_service`
  const ptzUrl   = ptzUrlMatch?.[1]?.trim()   || null

  // GetProfiles
  const profXml = await onvifPost(mediaUrl,
    `<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>`,
    user, pass)

  // Parse each profile block
  const profileRe = /<[^:>]*:?Profiles[^>]+token="([^"]+)"[^>]*>([\s\S]*?)<\/[^:>]*:?Profiles>/g
  const rawProfiles = []; let m
  while ((m = profileRe.exec(profXml)) !== null) rawProfiles.push({ token: m[1], xml: m[2] })

  // GetStreamUri for each profile (parallel)
  const profiles = await Promise.all(rawProfiles.map(async ({ token, xml }) => {
    const name     = xmlFirst(xml, 'Name') || token
    const hasAudio = xml.includes('AudioEncoderConfiguration')
    const hasPtz   = xml.includes('PTZConfiguration')
    const venc     = xml.match(/<[^:>]*:?Encoding>([^<]+)<\/[^:>]*:?Encoding>/)?.[1]?.trim()

    let streamPath = null, rtspUri = null
    try {
      const uriXml = await onvifPost(mediaUrl,
        `<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:StreamSetup><tt:Stream xmlns:tt="http://www.onvif.org/ver10/schema">RTP-Unicast</tt:Stream><tt:Transport xmlns:tt="http://www.onvif.org/ver10/schema"><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${token}</trt:ProfileToken></trt:GetStreamUri>`,
        user, pass, 5000)
      rtspUri = xmlFirst(uriXml, 'Uri')
      if (rtspUri) {
        const u = new URL(rtspUri.replace(/^rtsp:\/\//,'http://').replace(/^rtsps:\/\//,'https://'))
        streamPath = (u.pathname.replace(/^\//,'') + u.search).trim()
      }
    } catch(e) { console.error(`[onvif] GetStreamUri ${token}:`, e.message) }

    return { token, name, hasAudio, hasPtz, encoding: venc, streamPath, rtspUri }
  }))

  const ptzServiceUrl = ptzUrl || `${baseUrl}/onvif/ptz_service`
  const ptzToken = rawProfiles.find(p => p.xml.includes('PTZConfiguration'))?.token || rawProfiles[0]?.token || null
  return { profiles: profiles.filter(p => p.streamPath), hasPTZ: !!ptzUrl, ptzServiceUrl, ptzProfileToken: ptzToken }
}

app.get('/api/cameras/:id/onvif/discover', requireAuth, async (req, res) => {
  const dev = devices[req.params.id]
  if (!dev || dev.type !== 'camera') return res.status(404).json({ error: 'not found' })
  try {
    const result = await onvifDiscoverDevice(dev.ip, dev.username, dev.password)
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/cameras/onvif/probe', requireAuth, async (req, res) => {
  const { ip, username, password } = req.body
  if (!ip) return res.status(400).json({ error: 'ip required' })
  try {
    const result = await onvifDiscoverDevice(ip, username || '', password || '')
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/cameras/:id/onvif/ptz', requireAuth, async (req, res) => {
  const dev = devices[req.params.id]
  if (!dev || dev.type !== 'camera') return res.status(404).json({ error: 'not found' })
  const { pan=0, tilt=0, action='move' } = req.body
  const ptzUrl = dev.ptzServiceUrl || `http://${dev.ip}:8000/onvif/ptz_service`

  // Auto-discover profile token if not stored (e.g. camera added before ONVIF feature)
  if (!dev.ptzProfileToken) {
    try {
      const mediaUrl = ptzUrl.replace('ptz_service', 'media_service')
      const profXml = await onvifPost(mediaUrl, `<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>`, dev.username, dev.password, 4000)
      const m = profXml.match(/<[^:>]*:?Profiles[^>]+token="([^"]+)"/)
      if (m) {
        dev.ptzProfileToken = m[1]
        const cfg = config.devices.find(d => d.id === dev.id)
        if (cfg) { cfg.ptzProfileToken = m[1]; saveConfig(config) }
        console.log(`[${dev.id}] PTZ profile auto-discovered: ${m[1]}`)
      }
    } catch(e) { console.error(`[${dev.id}] PTZ auto-discover failed:`, e.message) }
  }

  const profileToken = dev.ptzProfileToken
  if (!profileToken) return res.status(400).json({ error: 'no PTZ profile token' })

  const ptzSoap = (ns, tok, p, t) => action === 'stop' || (p === 0 && t === 0)
    ? `<tptz:Stop xmlns:tptz="${ns}"><tptz:ProfileToken>${tok}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>false</tptz:Zoom></tptz:Stop>`
    : `<tptz:ContinuousMove xmlns:tptz="${ns}"><tptz:ProfileToken>${tok}</tptz:ProfileToken><tptz:Velocity><tt:PanTilt xmlns:tt="http://www.onvif.org/ver10/schema" x="${p}" y="${t}"/></tptz:Velocity></tptz:ContinuousMove>`

  try {
    let xml
    for (const ns of ['http://www.onvif.org/ver20/ptz/wsdl', 'http://www.onvif.org/ver10/ptz/wsdl']) {
      xml = await onvifPost(ptzUrl, ptzSoap(ns, profileToken, pan, tilt), dev.username, dev.password)
      if (!xml?.includes('not implemented') && !xml?.includes('namespace not recognized')) break
      console.log(`[ptz] ns ${ns} not supported, trying next`)
    }
    console.log(`[ptz] ${action} token=${profileToken} pan=${pan} tilt=${tilt} → ${xml?.slice(0,200)}`)
    if (xml?.includes('Fault')) return res.status(500).json({ error: 'ONVIF Fault', detail: xml.slice(0,1000) })
    res.json({ ok: true })
  } catch(e) { console.error('[ptz]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Hue API ───────────────────────────────────────────────────────────────────
app.post('/api/hue/discover', async (req,res) => {
  try {
    const r=await fetch('https://discovery.meethue.com/')
    res.json(await r.json())
  } catch { res.json([]) }
})

app.post('/api/hue/pair', async (req,res) => {
  const {ip}=req.body
  if (!ip) return res.status(400).json({error:'ip required'})
  const deadline=Date.now()+30000
  while (Date.now()<deadline) {
    try {
      const r=await fetch(`http://${ip}/api`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({devicetype:'edgecontroller#pi5'})
      })
      const data=await r.json()
      if (data[0]?.success?.username) return res.json({ok:true,token:data[0].success.username})
      if (data[0]?.error?.type!==101) return res.status(400).json({error:data[0]?.error?.description||'pairing failed'})
    } catch(err) { return res.status(500).json({error:err.message}) }
    await new Promise(r=>setTimeout(r,1000))
  }
  res.status(408).json({error:'Timed out — press the button on the bridge and try again'})
})

app.get('/api/devices/:id/hue/inventory', async (req,res) => {
  const dev=devices[req.params.id]
  if (!dev||dev.type!=='hue') return res.status(404).json({error:'not found'})
  try {
    await dev.loadInventory()
    broadcast({type:'hue:inventory',id:dev.id,...dev._inventory()})
    res.json(dev._inventory())
  } catch(err) { res.status(500).json({error:err.message}) }
})

app.post('/api/devices/:id/hue/select', (req,res) => {
  const dev=devices[req.params.id]
  if (!dev||dev.type!=='hue') return res.status(404).json({error:'not found'})
  const {selectedLights,selectedGroups,selectedScenes}=req.body
  if (selectedLights) dev.selectedLights=selectedLights
  if (selectedGroups) dev.selectedGroups=selectedGroups
  if (selectedScenes) dev.selectedScenes=selectedScenes
  const cfg=config.devices.find(d=>d.id===dev.id)
  if (cfg) { cfg.selectedLights=dev.selectedLights; cfg.selectedGroups=dev.selectedGroups; cfg.selectedScenes=dev.selectedScenes; saveConfig(config) }
  broadcast({type:'device:updated',device:dev.toJSON()})
  res.json({ok:true})
})

app.post('/api/devices/:id/hue/light/:lightId', async (req,res) => {
  const dev=devices[req.params.id]
  if (!dev||dev.type!=='hue') return res.status(404).json({error:'not found'})
  try { await dev.setLight(req.params.lightId,req.body); res.json({ok:true}) }
  catch(err) { res.status(500).json({error:err.message}) }
})

app.post('/api/devices/:id/hue/group/:groupId', async (req,res) => {
  const dev=devices[req.params.id]
  if (!dev||dev.type!=='hue') return res.status(404).json({error:'not found'})
  try { await dev.setGroup(req.params.groupId,req.body); res.json({ok:true}) }
  catch(err) { res.status(500).json({error:err.message}) }
})

app.post('/api/devices/:id/hue/scene', async (req,res) => {
  const dev=devices[req.params.id]
  if (!dev||dev.type!=='hue') return res.status(404).json({error:'not found'})
  const {sceneId}=req.body
  if (!sceneId) return res.status(400).json({error:'sceneId required'})
  try { await dev.activateScene(sceneId); res.json({ok:true}) }
  catch(err) { res.status(500).json({error:err.message}) }
})

app.post('/api/devices/:id/cmd', (req,res) => {
  const dev=devices[req.params.id]; if (!dev) return res.status(404).json({error:'not found'})
  const {channel,params}=req.body; if (dev.setChannel&&channel) dev.setChannel(channel,params); res.json({ok:true})
})

app.get('/api/config',  requireAdmin, (req,res) => res.json(safeConfig()))
app.put('/api/config',  requireAdmin, (req,res) => { const {boxId}=req.body; if(boxId)config.boxId=boxId; saveConfig(config); res.json(safeConfig()) })

app.get('/api/waveforms', (req,res) => res.json({builtin:BUILTIN_WAVEFORMS,custom:waveformStore.custom}))

app.post('/api/waveforms', (req,res) => {
  const {name,frames}=req.body
  if (!name||!frames||!Array.isArray(frames)||!frames.length) return res.status(400).json({error:'name and frames[] required'})
  const id=`wf-${Date.now()}`, wf={id,name,frames}
  waveformStore.custom.push(wf); saveWaveforms()
  broadcast({type:'waveforms:updated',waveforms:waveformsMeta()})
  res.json(wf)
})

app.put('/api/waveforms/:id', (req,res) => {
  const idx=waveformStore.custom.findIndex(w=>w.id===req.params.id)
  if (idx===-1) return res.status(404).json({error:'not found'})
  const {name,frames}=req.body
  if (name) waveformStore.custom[idx].name=name
  if (frames) waveformStore.custom[idx].frames=frames
  saveWaveforms()
  broadcast({type:'waveforms:updated',waveforms:waveformsMeta()})
  res.json(waveformStore.custom[idx])
})

app.delete('/api/waveforms/:id', (req,res) => {
  const idx=waveformStore.custom.findIndex(w=>w.id===req.params.id)
  if (idx===-1) return res.status(404).json({error:'not found'})
  waveformStore.custom.splice(idx,1); saveWaveforms()
  broadcast({type:'waveforms:updated',waveforms:waveformsMeta()})
  res.json({ok:true})
})

// ── Shutdown / Start ──────────────────────────────────────────────────────────
// ── Groups API ────────────────────────────────────────────────────────────────
app.get('/api/groups', (req,res) => res.json(config.groups||[]))

app.post('/api/groups', (req,res) => {
  const {name,channels}=req.body
  if(!name) return res.status(400).json({error:'name required'})
  if(!Array.isArray(channels)||channels.length===0) return res.status(400).json({error:'channels required'})
  const id=`group-${Date.now()}`, group={id,name,channels}
  if(!config.groups) config.groups=[]
  config.groups.push(group); saveConfig(config)
  broadcast({type:'group:added',group})
  if (streamDeck) streamDeck.updateGroups(config.groups)
  res.json(group)
})

app.put('/api/groups/:id', (req,res) => {
  const g=(config.groups||[]).find(g=>g.id===req.params.id)
  if(!g) return res.status(404).json({error:'not found'})
  const {name,channels}=req.body
  if(name) g.name=name; if(Array.isArray(channels)) g.channels=channels
  saveConfig(config); broadcast({type:'group:updated',group:g})
  if (streamDeck) streamDeck.updateGroups(config.groups)
  res.json(g)
})

app.delete('/api/groups/:id', (req,res) => {
  const idx=(config.groups||[]).findIndex(g=>g.id===req.params.id)
  if(idx===-1) return res.status(404).json({error:'not found'})
  config.groups.splice(idx,1); saveConfig(config)
  broadcast({type:'group:removed',id:req.params.id})
  if (streamDeck) streamDeck.updateGroups(config.groups)
  res.json({ok:true})
})

// ── Macros ────────────────────────────────────────────────────────────────────
function loadMacros() {
  if (!existsSync(MACROS_PATH)) { writeFileSync(MACROS_PATH, '[]'); return [] }
  try { return JSON.parse(readFileSync(MACROS_PATH, 'utf8')) } catch { return [] }
}
function saveMacros() { writeFileSync(MACROS_PATH, JSON.stringify(macroStore, null, 2)) }
let macroStore = loadMacros()

const macroRunners = {}

function getEomArousal() {
  const eom = Object.values(devices).find(d => d.type === 'eom' && d.status === 'connected')
  return eom ? (eom._readings?.arousal ?? 0) : 0
}

class MacroRunner {
  constructor(macro) {
    this.macro = macro
    this.id = macro.id
    this._abort = false
    this._waitResolve = null
  }

  stop() {
    this._abort = true
    if (this._waitResolve) this._waitResolve('abort')
  }

  resume() {
    if (this._waitResolve) this._waitResolve('ok')
  }

  _sleep(ms) {
    return new Promise(resolve => {
      let done = false
      const tid = setTimeout(() => { done = true; resolve() }, ms)
      const poll = setInterval(() => { if (this._abort || done) { clearTimeout(tid); clearInterval(poll); resolve() } }, 50)
    })
  }

  async run() {
    const { blocks = [], conns = [] } = this.macro
    const blockMap = {}
    const adj = {}  // blockId -> { portType -> toBlockId }
    for (const b of blocks) { blockMap[b.id] = b; adj[b.id] = {} }
    for (const c of conns) { if (adj[c.fid]) adj[c.fid][c.fp] = c.tid }
    const start = blocks.find(b => b.type === 'start')
    if (!start) throw new Error('No START block')
    broadcast({ type: 'macro:running', id: this.macro.id, name: this.macro.name })
    try { await this._exec(start.id, blockMap, adj, 0) } catch(e) { if (!this._abort) console.error('[macro]', e.message) }
    broadcast({ type: 'macro:stopped', id: this.macro.id })
    delete macroRunners[this.id]
  }

  async _exec(blockId, blockMap, adj, depth=0) {
    if (this._abort || !blockId) return
    if (depth > 20) { console.error('[macro] Max nesting depth reached'); return }
    const block = blockMap[blockId]
    if (!block) return
    broadcast({ type: 'macro:step', id: this.macro.id, blockId, blockType: block.type, config: block.config })
    const next = (port = 'o') => adj[blockId]?.[port]
    const cfg = block.config || {}

    switch (block.type) {
      case 'start':
        await this._exec(next(), blockMap, adj, depth); break

      case 'end': break

      case 'stop_all':
        this._stopAll()
        await this._sleep(180)
        await this._exec(next(), blockMap, adj, depth); break

      case 'delay': {
        const durMs = (cfg.dur || 10) * 1000
        const endTime = Date.now() + durMs
        while (!this._abort) {
          const remaining = endTime - Date.now()
          if (remaining <= 0) break
          broadcast({ type: 'macro:countdown', id: this.macro.id, blockId, remaining: remaining / 1000, total: cfg.dur || 10 })
          await this._sleep(Math.min(200, remaining))
        }
        if (!this._abort) {
          broadcast({ type: 'macro:countdown', id: this.macro.id, blockId, remaining: 0, total: cfg.dur || 10 })
          await this._exec(next(), blockMap, adj, depth)
        }
        break
      }

      case 'ramp': {
        const prom = this._doRamp(block)
        if (cfg.block) { await prom; await this._exec(next(), blockMap, adj, depth) }
        else { prom.catch(() => {}); await this._exec(next(), blockMap, adj, depth) }
        break
      }

      case 'wait_eom': {
        const gt = (cfg.cond || '').includes('>')
        const thresh = cfg.thr ?? 70
        const deadline = (cfg.timeout > 0) ? Date.now() + cfg.timeout * 1000 : Infinity
        while (!this._abort) {
          if (gt ? getEomArousal() > thresh : getEomArousal() < thresh) break
          if (Date.now() > deadline) break
          await this._sleep(500)
        }
        await this._exec(next(), blockMap, adj, depth); break
      }

      case 'wait_manual': {
        broadcast({ type: 'macro:wait', id: this.macro.id, blockId, prompt: cfg.prompt || 'Continue when ready' })
        await new Promise(r => { this._waitResolve = r })
        this._waitResolve = null
        if (!this._abort) await this._exec(next(), blockMap, adj, depth)
        break
      }

      case 'wait_pawprints': {
        const pp = (cfg.ppRef && devices[cfg.ppRef]?.status === 'connected') ? devices[cfg.ppRef] : Object.values(devices).find(d => d instanceof PawPrintsDevice && d.status === 'connected')
        if (!pp) {
          // No device connected — skip the wait
          await this._exec(next(), blockMap, adj, depth); break
        }
        const mode = cfg.mode || 'Button Press'
        if (mode === 'Button Press') {
          const btnIdx = { B1: 0, B2: 1, B3: 2 }[cfg.button]  // undefined = Any
          let prevState = pp.buttons.slice()
          broadcast({ type: 'macro:wait', id: this.macro.id, blockId, prompt: cfg.button && cfg.button !== 'Any' ? `Press ${cfg.button} on PawPrints` : 'Press any PawPrints button' })
          while (!this._abort) {
            const cur = pp.buttons
            // Detect rising edge: was false, now true
            const triggered = btnIdx !== undefined
              ? (!prevState[btnIdx] && cur[btnIdx])
              : cur.some((v, i) => !prevState[i] && v)
            if (triggered) break
            prevState = cur.slice()
            await this._sleep(50)
          }
        } else {
          // Tilt deviation mode — trigger when device moves away from calibrated position
          const axis = cfg.axis || 'Any'
          const sensitivity = cfg.sensitivity ?? 15
          const cal = { x: cfg.calX ?? 0, y: cfg.calY ?? 0, z: cfg.calZ ?? 0 }
          const axes = axis === 'Any' ? ['x','y','z'] : [axis.toLowerCase()]
          broadcast({ type: 'macro:wait', id: this.macro.id, blockId, prompt: `Waiting for tilt on ${axis}...` })
          while (!this._abort) {
            const hit = axes.some(a => Math.abs((pp.accel[a] ?? 0) - cal[a]) > sensitivity)
            if (hit) break
            await this._sleep(100)
          }
        }
        this._waitResolve = null
        if (!this._abort) await this._exec(next(), blockMap, adj, depth)
        break
      }

      case 'if_else': {
        const gt = (cfg.cond || '').includes('>')
        const yes = gt ? getEomArousal() > (cfg.thr ?? 80) : getEomArousal() < (cfg.thr ?? 80)
        broadcast({ type: 'macro:label', id: this.macro.id, blockId, text: yes ? '→ YES' : '→ NO', color: yes ? '#4ade80' : '#f87171' })
        await this._sleep(350)
        await this._exec(next(yes ? 'oy' : 'on'), blockMap, adj, depth); break
      }

      case 'if_pawprints': {
        const pp = (cfg.ppRef && devices[cfg.ppRef]?.status === 'connected') ? devices[cfg.ppRef] : Object.values(devices).find(d => d instanceof PawPrintsDevice && d.status === 'connected')
        if (!pp) {
          broadcast({ type: 'macro:label', id: this.macro.id, blockId, text: '→ NO (no device)', color: '#f87171' })
          await this._sleep(350)
          await this._exec(next('on'), blockMap, adj, depth); break
        }
        const mode = cfg.mode || 'Button Press'
        let yes = false
        if (mode === 'Button Press') {
          // Wait for any button press, YES if it matches configured button
          const btnIdx = { B1: 0, B2: 1, B3: 2 }[cfg.button]  // undefined = Any
          let prevState = pp.buttons.slice()
          while (!this._abort) {
            const cur = pp.buttons
            const pressedIdx = cur.findIndex((v, i) => !prevState[i] && v)
            if (pressedIdx !== -1) {
              yes = btnIdx === undefined ? true : pressedIdx === btnIdx
              break
            }
            prevState = cur.slice()
            await this._sleep(50)
          }
        } else {
          // Tilt: instant snapshot — YES if currently past threshold
          const axis = cfg.axis || 'Any'
          const sensitivity = cfg.sensitivity ?? 15
          const cal = { x: cfg.calX ?? 0, y: cfg.calY ?? 0, z: cfg.calZ ?? 0 }
          const axes = axis === 'Any' ? ['x','y','z'] : [axis.toLowerCase()]
          yes = axes.some(a => Math.abs((pp.accel[a] ?? 0) - cal[a]) > sensitivity)
        }
        broadcast({ type: 'macro:label', id: this.macro.id, blockId, text: yes ? '→ YES' : '→ NO', color: yes ? '#4ade80' : '#f87171' })
        await this._sleep(350)
        if (!this._abort) await this._exec(next(yes ? 'oy' : 'on'), blockMap, adj, depth)
        break
      }

      case 'loop': {
        const body = next('ob'), done = next('od')
        if (cfg.mode === 'Repeat N times') {
          for (let i = 0; i < (cfg.count || 3) && !this._abort; i++) {
            broadcast({ type: 'macro:label', id: this.macro.id, blockId, text: `× ${i+1} / ${cfg.count||3}`, color: '#a5b4fc' })
            if (body) await this._exec(body, blockMap, adj, depth)
          }
        } else {
          const gt = (cfg.mode || '').includes('>')
          let iter = 0
          while (!this._abort) {
            if (gt ? getEomArousal() > (cfg.thr ?? 75) : getEomArousal() < (cfg.thr ?? 75)) break
            iter++
            broadcast({ type: 'macro:label', id: this.macro.id, blockId, text: `× ${iter}`, color: '#a5b4fc' })
            if (body) await this._exec(body, blockMap, adj, depth)
          }
        }
        await this._exec(done, blockMap, adj, depth); break
      }

      case 'run_macro': {
        const sub = macroStore.find(m => m.id === cfg.macroId)
        if (sub) {
          const subBlocks = sub.blocks || [], subConns = sub.conns || []
          const subMap = {}, subAdj = {}
          for (const b of subBlocks) { subMap[b.id] = b; subAdj[b.id] = {} }
          for (const c of subConns) { if (subAdj[c.fid]) subAdj[c.fid][c.fp] = c.tid }
          const subStart = subBlocks.find(b => b.type === 'start')
          if (subStart) await this._exec(subStart.id, subMap, subAdj, depth + 1)
        } else {
          console.warn('[macro] run_macro: macro not found:', cfg.macroId)
        }
        await this._exec(next(), blockMap, adj, depth); break
      }

      case 'dev':
        this._applyDev(block)
        await this._sleep(180)
        await this._exec(next(), blockMap, adj, depth); break

      case 'hue_set': {
        const [devId, targetType, targetId] = (cfg.hueTarget || '').split(':')
        const hue = devId ? devices[devId] : Object.values(devices).find(d => d.type === 'hue' && d.status === 'connected')
        if (hue && hue.status === 'connected' && targetType && targetId) {
          const turnOff = cfg.action === 'off'
          if (targetType === 'scene') {
            if (turnOff) {
              const grpId = hue._scenes?.[targetId]?.group
              if (grpId) hue.setGroup(grpId, { on: false })
            } else {
              hue.activateScene(targetId)
              if (cfg.bri !== undefined) {
                const grpId = hue._scenes?.[targetId]?.group
                if (grpId) setTimeout(() => hue.setGroup(grpId, { bri: cfg.bri }), 300)
              }
            }
          } else if (targetType === 'group') {
            if (turnOff) hue.setGroup(targetId, { on: false })
            else hue.setGroup(targetId, { on: true, bri: cfg.bri })
          }
        }
        await this._sleep(350)
        await this._exec(next(), blockMap, adj, depth); break
      }

      case 'hue_ramp': {
        const prom = this._doHueRamp(block)
        if (cfg.block) { await prom; await this._exec(next(), blockMap, adj, depth) }
        else { prom.catch(() => {}); await this._exec(next(), blockMap, adj, depth) }
        break
      }
    }
  }

  _stopAll() {
    for (const dev of Object.values(devices)) {
      if (dev.status !== 'connected') continue
      if (dev.type === 'coyote') { dev.setChannel('A', { intensity: 0 }); dev.setChannel('B', { intensity: 0 }) }
      else if (dev.type === 'estim' && dev.setChannel) { dev.setChannel('A', { power: 0 }); dev.setChannel('B', { power: 0 }) }
      else if (dev.type === 'nimble' && dev.setMotor) dev.setMotor(0)
    }
  }

  _applyDev(block) {
    const { devRef, channel, config: cfg = {} } = block
    const dev = devices[devRef]
    if (!dev || dev.status !== 'connected') return
    if (dev.type === 'coyote') {
      const ch = channel || 'A'
      const upd = {}
      if (cfg.waveform) upd.waveform = cfg.waveform
      if (cfg.intensity !== undefined) upd.intensity = Math.round(cfg.intensity)
      if (cfg.speed !== undefined) upd.speed = cfg.speed
      dev.setChannel(ch, upd)
    } else if (dev.type === 'estim' && dev.setChannel) {
      if (cfg.powerA !== undefined) dev.setChannel('A', { power: cfg.powerA })
      if (cfg.powerB !== undefined) dev.setChannel('B', { power: cfg.powerB })
      if (cfg.mode !== undefined) dev.setMode?.(cfg.mode)
    } else if (dev.type === 'nimble') {
      if (cfg.speed !== undefined && dev.setMotor) dev.setMotor(cfg.speed)
    } else if (dev.type === 'hue') {
      const [targetType, targetId] = (block.channel || '').split(':')
      const turnOff = cfg.action === 'off'
      if (targetType === 'scene') {
        if (turnOff) {
          const grpId = dev._scenes?.[targetId]?.group
          if (grpId) dev.setGroup(grpId, { on: false })
        } else {
          dev.activateScene(targetId)
          if (cfg.bri !== undefined) {
            const grpId = dev._scenes?.[targetId]?.group
            if (grpId) setTimeout(() => dev.setGroup(grpId, { bri: cfg.bri }), 300)
          }
        }
      } else if (targetType === 'group') {
        if (turnOff) {
          dev.setGroup(targetId, { on: false })
        } else {
          const params = { on: true }
          if (cfg.bri !== undefined) params.bri = cfg.bri
          dev.setGroup(targetId, params)
        }
      }
    }
  }

  async _doHueRamp(block) {
    const cfg = block.config || {}
    const [devId, targetType, targetId] = (cfg.hueTarget || '').split(':')
    if (!targetType || !targetId) return
    const from = cfg.from ?? 0, to = cfg.to ?? 100, durMs = (cfg.dur || 30) * 1000
    const steps = Math.max(6, Math.round(durMs / 500))
    const hue = devId ? devices[devId] : Object.values(devices).find(d => d.type === 'hue' && d.status === 'connected')
    if (!hue || hue.status !== 'connected') return
    let groupId
    if (targetType === 'scene') {
      groupId = hue._scenes?.[targetId]?.group
      hue.activateScene(targetId)
      await this._sleep(300)
    } else if (targetType === 'group') {
      groupId = targetId
    }
    if (!groupId) return
    const total = cfg.dur || 30
    const stepMs = durMs / steps
    for (let i = 0; i <= steps && !this._abort; i++) {
      const t = i / steps, val = Math.round(from + (to - from) * t)
      broadcast({ type: 'macro:ramp', id: this.macro.id, blockId: block.id, value: val, from, to, elapsed: t * total, total })
      hue.setGroup(groupId, { bri: val, on: true, transitiontime: Math.round(stepMs / 100) })
      if (i < steps) await this._sleep(stepMs)
    }
  }

  async _doRamp(block) {
    const { devRef, channel, config: cfg = {} } = block
    const from = cfg.from ?? 0, to = cfg.to ?? 100, durMs = (cfg.dur || 60) * 1000
    const steps = Math.max(10, Math.round(durMs / 200))
    const dev = devRef ? devices[devRef] : null
    const total = cfg.dur || 60
    for (let i = 0; i <= steps && !this._abort; i++) {
      const t = i / steps, val = from + (to - from) * t
      broadcast({ type: 'macro:ramp', id: this.macro.id, blockId: block.id,
                  value: Math.round(val), from, to, elapsed: t * total, total })
      if (dev) {
        // Ramp specific device
        if (dev.type === 'coyote' && dev.status === 'connected')
          dev.setChannel(channel || 'A', { intensity: Math.round(val) })
        else if (dev.type === 'estim' && dev.status === 'connected' && dev.setChannel) {
          dev.setChannel('A', { power: Math.round(val) }); dev.setChannel('B', { power: Math.round(val) })
        }
      } else {
        // No device specified — ramp all connected coyotes
        for (const d of Object.values(devices))
          if (d.type === 'coyote' && d.status === 'connected') {
            d.setChannel('A', { intensity: Math.round(val) })
            d.setChannel('B', { intensity: Math.round(val) })
          }
      }
      if (i < steps) await this._sleep(durMs / steps)
    }
  }
}

// Macros CRUD
app.get('/api/macros', (req, res) => res.json(macroStore))

app.post('/api/macros', (req, res) => {
  const { name, blocks, conns } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  const macro = { id: 'macro-' + Date.now(), name, blocks: blocks || [], conns: conns || [], createdAt: Date.now() }
  macroStore.push(macro); saveMacros()
  broadcast({ type: 'macro:added', macro })
  streamDeck?.updateMacros(macroStore)
  res.json(macro)
})

app.put('/api/macros/:id', (req, res) => {
  const m = macroStore.find(x => x.id === req.params.id)
  if (!m) return res.status(404).json({ error: 'not found' })
  const { name, blocks, conns } = req.body || {}
  if (name !== undefined) m.name = name
  if (blocks !== undefined) m.blocks = blocks
  if (conns !== undefined) m.conns = conns
  m.updatedAt = Date.now(); saveMacros()
  broadcast({ type: 'macro:updated', macro: m })
  streamDeck?.updateMacros(macroStore)
  res.json(m)
})

app.delete('/api/macros/:id', (req, res) => {
  const idx = macroStore.findIndex(x => x.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })
  macroStore.splice(idx, 1); saveMacros()
  broadcast({ type: 'macro:removed', id: req.params.id })
  streamDeck?.updateMacros(macroStore)
  res.json({ ok: true })
})

app.post('/api/macros/:id/run', (req, res) => {
  const macro = macroStore.find(x => x.id === req.params.id)
  if (!macro) return res.status(404).json({ error: 'not found' })
  if (macroRunners[req.params.id]) return res.status(409).json({ error: 'already running' })
  const runner = new MacroRunner(macro)
  macroRunners[req.params.id] = runner
  runner.run().catch(e => console.error('[macro] run error:', e.message))
  res.json({ ok: true })
})

app.post('/api/macros/:id/stop', (req, res) => {
  macroRunners[req.params.id]?.stop()
  res.json({ ok: true })
})

app.post('/api/macros/:id/resume', (req, res) => {
  macroRunners[req.params.id]?.resume()
  res.json({ ok: true })
})

// ── Audio API ─────────────────────────────────────────────────────────────────
// Extract amplitude envelope from audio file via ffmpeg
// lowCut/highCut: band-pass filter in Hz (20=no low cut, 20000=no high cut)
// Returns array of 0-100 amplitude values, one per 100ms
function extractAmplitudeEnvelope(filePath, lowCut=20, highCut=20000, onProgress=null) {
  return new Promise((resolve, reject) => {
    // Use lowest sample rate that correctly captures the high cut frequency
    // Nyquist = 2x highCut, add 4x headroom. Floor at 4000, ceil at 44100.
    const SAMPLE_RATE = Math.min(44100, Math.max(4000, highCut * 4))
    const CHUNK      = Math.floor(SAMPLE_RATE * 0.1) // 100ms of samples
    const BYTES      = CHUNK * 4                      // f32le = 4 bytes each
    const frames     = []
    let   leftover   = Buffer.alloc(0)

    // Build band-pass filter: highpass (low cut) + lowpass (high cut)
    const filters = []
    if (lowCut  >    20) filters.push(`highpass=f=${lowCut}`)
    if (highCut < 20000) filters.push(`lowpass=f=${highCut}`)
    const ffArgs = ['-i', filePath, '-ac', '1']
    if (filters.length) ffArgs.push('-af', filters.join(','))
    ffArgs.push('-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1')

    const ff = spawn('ffmpeg', ffArgs,
      { stdio: ['ignore', 'pipe', 'ignore'] })

    ff.stdout.on('data', chunk => {
      const buf = Buffer.concat([leftover, chunk])
      let pos = 0
      while (pos + BYTES <= buf.length) {
        let sum = 0
        for (let i = 0; i < CHUNK; i++) sum += Math.pow(buf.readFloatLE(pos + i * 4), 2)
        const rms = Math.sqrt(sum / CHUNK)
        frames.push(Math.min(100, Math.round(rms * 500))) // scale RMS → 0-100
        if (onProgress && frames.length % 10 === 0) onProgress(frames.length)
        pos += BYTES
      }
      leftover = buf.slice(pos)
    })
    ff.on('close', code => code === 0 || frames.length > 0 ? resolve(frames) : reject(new Error('ffmpeg failed')))
    ff.on('error', reject)
  })
}

app.get('/api/audio', (req,res) => {
  // Return audio waveforms from the waveform store
  res.json((waveformStore.custom||[]).filter(w=>w.type==='audio').map(w=>({
    id:w.id, name:w.name, frames:w.frames.length, duration:Math.round(w.frames.length/10)
  })))
})

app.post('/api/audio', audioUpload.single('file'), async (req,res) => {
  if(!req.file) return res.status(400).json({error:'No file uploaded'})
  const filePath=join(AUDIO_DIR,req.file.filename)
  try {
    console.log(`[audio] Analysing ${req.file.originalname} (${Math.round(req.file.size/1024)}KB)...`)
    const lowCut  = Math.max(20,    Math.min(19950, parseInt(req.body.lowCut)  || 20))
    const highCut = Math.max(50, Math.min(20000, parseInt(req.body.highCut) || 20000))
    if (lowCut > 20 || highCut < 20000) console.log(`[audio] Band-pass: ${lowCut}Hz – ${highCut}Hz`)
    const audioStartTime = Date.now()
    const audioName = req.file.originalname
    broadcast({type:'audio:progress', name:audioName, frames:0, elapsed:0, done:false})
    const amps=await extractAmplitudeEnvelope(filePath, lowCut, highCut, (frames) => {
      const elapsed = Math.round((Date.now() - audioStartTime) / 1000)
      broadcast({type:'audio:progress', name:audioName, frames, elapsed, done:false})
    })
    console.log(`[audio] ${amps.length} frames (${Math.round(amps.length/10)}s)`)
    const wfId='audio-'+req.file.filename
    const wf={id:wfId, name:req.file.originalname, type:'audio', sourceFile:req.file.filename, frames:amps}
    waveformStore.custom.push(wf); saveWaveforms()
    broadcast({type:'audio:progress', name:req.file.originalname, frames:amps.length,
      elapsed:0, done:true, duration:Math.round(amps.length/10)})
    broadcast({type:'waveforms:updated',waveforms:waveformsMeta()})
    res.json({id:wfId, name:req.file.originalname, frames:amps.length, duration:Math.round(amps.length/10)})
  } catch(e) {
    console.error('[audio] Error:',e.message)
    try{unlinkSync(filePath)}catch{}
    res.status(500).json({error:'Audio processing failed: '+e.message})
  }
})

app.delete('/api/audio/:id', (req,res) => {
  const wf=(waveformStore.custom||[]).find(w=>w.id===req.params.id&&w.type==='audio')
  if(!wf) return res.status(404).json({error:'not found'})
  try{unlinkSync(join(AUDIO_DIR,wf.sourceFile))}catch{}
  const idx=waveformStore.custom.findIndex(w=>w.id===req.params.id)
  if(idx!==-1) waveformStore.custom.splice(idx,1)
  saveWaveforms()
  broadcast({type:'waveforms:updated',waveforms:waveformsMeta()})
  res.json({ok:true})
})

app.get('/api/audio/:id/file', (req,res) => {
  const wf=(waveformStore.custom||[]).find(w=>w.id===req.params.id&&w.type==='audio')
  if(!wf) return res.status(404).json({error:'not found'})
  res.sendFile(join(AUDIO_DIR, wf.sourceFile))
})

// ── WiFi API ──────────────────────────────────────────────────────────────────
function nmcli(...args) {
  return new Promise((resolve, reject) => {
    exec('sudo nmcli ' + args.join(' '), (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error(stderr || err.message))
      else resolve(stdout.trim())
    })
  })
}

app.get('/api/wifi/status', requireAdmin, async (req, res) => {
  try {
    const out = await nmcli('-t -f active,ssid,signal,bars dev wifi')
    const connected = out.split('\n').find(l => l.startsWith('yes:'))
    if (!connected) return res.json({ connected: false })
    const [, ssid, signal, bars] = connected.split(':')
    const ip = await nmcli('-t -f IP4.ADDRESS dev show wlan0').catch(() => '')
    const ipAddr = (ip.match(/IP4\.ADDRESS\[1\]:(.+)/) || [])[1]?.split('/')[0] || ''
    res.json({ connected: true, ssid, signal: parseInt(signal), bars, ip: ipAddr })
  } catch(e) { res.json({ connected: false, error: e.message }) }
})

app.post('/api/wifi/scan', async (req, res) => {
  try {
    await nmcli('dev wifi rescan').catch(() => {})
    await new Promise(r => setTimeout(r, 2000))
    const out = await nmcli('-t -f ssid,signal,security,in-use dev wifi list')
    const seen = new Set()
    const networks = out.split('\n')
      .map(l => {
        const parts = l.split(':')
        if (parts.length < 3) return null
        const ssid = parts[0], signal = parseInt(parts[1]), security = parts[2], inUse = parts[3] === '*'
        if (!ssid) return null
        if (seen.has(ssid)) return null
        seen.add(ssid)
        return { ssid, signal, security: security || 'Open', inUse }
      })
      .filter(Boolean)
      .sort((a, b) => b.signal - a.signal)
    res.json(networks)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/wifi/connect', async (req, res) => {
  const { ssid, password } = req.body || {}
  if (!ssid) return res.status(400).json({ error: 'SSID required' })
  try {
    await nmcli(`connection delete "${ssid}"`).catch(() => {})
    const cmd = password
      ? `dev wifi connect "${ssid}" password "${password}" ifname wlan0`
      : `dev wifi connect "${ssid}" ifname wlan0`
    const out = await nmcli(cmd)
    // If we were in AP setup mode, reboot so edge-network starts clean
    // (clears the AP flag, iptables rules, and hotspot NM connection)
    if (existsSync(AP_FLAG)) {
      res.json({ ok: true, message: out, rebooting: true })
      setTimeout(() => exec('sudo reboot'), 2000)
    } else {
      res.json({ ok: true, message: out })
    }
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/wifi/ap-status', (req, res) => {
  const isAP = existsSync(AP_FLAG)
  res.json({ apMode: isAP, ssid: isAP ? readFileSync(AP_FLAG, 'utf8').trim() : null })
})

app.post('/api/wifi/reset', requireAuth, async (req, res) => {
  // Clear saved WiFi creds from boot config (FAT32 owned by root — use sudo sed)
  await new Promise(r => exec(
    "sudo sed -i 's/^ssid[ \\t]*=.*/ssid =/' /boot/firmware/edgecontroller.conf && " +
    "sudo sed -i 's/^password[ \\t]*=.*/password =/' /boot/firmware/edgecontroller.conf",
    r
  )).catch(() => {})
  res.json({ ok: true, message: 'Rebooting into setup mode...' })
  // Delete all saved WiFi connections so NM has nothing to auto-connect on next boot,
  // then reboot — edge-network will find no internet and start AP mode
  setTimeout(() => {
    exec('sudo nmcli -t -f name,type con show | grep wireless | cut -d: -f1', (err, out) => {
      const profiles = (out || '').trim().split('\n').filter(Boolean)
      let pending = profiles.length || 0
      const doReboot = () => { if (--pending <= 0) exec('sudo reboot') }
      if (!profiles.length) { exec('sudo reboot'); return }
      for (const name of profiles) {
        exec(`sudo nmcli con delete "${name}"`, doReboot)
      }
    })
  }, 1500)
})

// ─── Stream Deck+ ────────────────────────────────────────────────────────
function broadcastDeckStatus() {
  broadcast({
    type: 'deck:status',
    status: streamDeck ? 'connected' : 'disconnected',
    name: streamDeck?.deck?.PRODUCT_NAME || null
  })
}

async function initStreamDeck() {
  try {
    const macroCallbacks = {
      run: (id) => {
        const macro = macroStore.find(m => m.id === id)
        if (!macro || macroRunners[id]) return
        const runner = new MacroRunner(macro)
        macroRunners[id] = runner
        runner.run().catch(e => console.error('[macro] run error:', e.message))
      },
      stop:   (id) => macroRunners[id]?.stop(),
      resume: (id) => macroRunners[id]?.resume(),
    }
    streamDeck = new StreamDeckController(devices, broadcast, config.groups || [], macroCallbacks)
    const ok = await streamDeck.init()
    if (!ok) { streamDeck = null; broadcastDeckStatus(); return }
    streamDeck.updateMacros(macroStore)
    broadcastDeckStatus()
  } catch (e) {
    console.error('[deck] init error:', e.message)
    streamDeck = null
    broadcastDeckStatus()
  }
}

async function disconnectStreamDeck() {
  try { streamDeck?.close() } catch {}
  streamDeck = null
  broadcastDeckStatus()
}

// Init after a short delay so all devices have a chance to register
setTimeout(initStreamDeck, 3000)

process.on('SIGINT',  () => { tunnelStop(); destroy(); streamDeck?.close(); process.exit() })
process.on('SIGTERM', () => { tunnelStop(); destroy(); streamDeck?.close(); process.exit() })
process.on('uncaughtException',  err => console.error('[CRASH]',  err.message))
process.on('unhandledRejection', r   => console.error('[REJECT]', r))

// Start HTTP server immediately — don't wait for Bluetooth
server.listen(3000, '0.0.0.0', () => {
  console.log('EdgeController running on http://0.0.0.0:3000')
  if (config.tunnel?.token) {
    if (config.tunnel?.enabled) {
      console.log('[tunnel] auto-starting on boot...')
      tunnelStart()
    }
  } else {
    // No token yet — try to auto-provision
    autoProvision()
  }
})
// Restart Bluetooth in background (only needed for Coyote BLE, non-blocking)
exec('sudo systemctl restart bluetooth', err => {
  if (err) console.error('BT restart error:', err.message)
  else console.log('Bluetooth restarted')
})
