'use client'

// v2.9.0 — interactive three.js hero: a BRIGHT sky (shader gradient dome +
// sun + drifting cloud field) with a glossy red flying roadster (side-profile
// extrusion, glass canopy, spoked wheels, cyan hover-thrusters).
//
// Interactivity: OrbitControls (drag to orbit, wheel to zoom) with a gentle
// auto-rotate that yields to the user; the car BANKS toward the pointer;
// clicking the car fires a boost (rise + nose-up + thruster flare + speed
// streaks). Honors prefers-reduced-motion (no auto-rotate/boost; still
// draggable). Renders nothing during SSR (dynamically imported, ssr:false)
// and disposes every GPU resource on unmount.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/** Cheap WebGL capability probe for the lazy state initializer. */
function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export default function SkyScene() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // WebGL capability is probed in the lazy state initializer (client-only
  // component, ssr:false) — keeps the effect body free of synchronous setState.
  const [failed, setFailed] = useState(() => !hasWebGL())
  const [hintGone, setHintGone] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host || failed) return

    // ---------------------------------------------------------------- boot
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    } catch {
      queueMicrotask(() => setFailed(true))
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(host.clientWidth || 640, host.clientHeight || 360)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    host.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.touchAction = 'none'

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0xdcecff, 70, 340)

    const camera = new THREE.PerspectiveCamera(42, (host.clientWidth || 640) / (host.clientHeight || 360), 0.1, 900)
    camera.position.set(6.4, 2.9, 8.8)

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false

    // ----------------------------------------------------------------- sky
    const sunDir = new THREE.Vector3(-0.42, 0.4, -0.62).normalize()
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0.17, 0.44, 0.86) },
        horizonColor: { value: new THREE.Color(0.79, 0.9, 0.98) },
        hazeColor: { value: new THREE.Color(0.86, 0.93, 0.98) },
        sunColor: { value: new THREE.Color(1.0, 0.96, 0.82) },
        sunDir: { value: sunDir },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 hazeColor;
        uniform vec3 sunColor; uniform vec3 sunDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          float t = pow(clamp(h, 0.0, 1.0), 0.55);
          vec3 col = mix(horizonColor, topColor, t);
          col = mix(hazeColor, col, smoothstep(-0.22, 0.03, h));
          float s = max(dot(d, normalize(sunDir)), 0.0);
          col += sunColor * (pow(s, 260.0) * 1.4 + pow(s, 9.0) * 0.32);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    const sky = new THREE.Mesh(new THREE.SphereGeometry(420, 40, 24), skyMat)
    scene.add(sky)

    // sun sprites (disc core + wide halo)
    const sunTex = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 256
      const ctx = c.getContext('2d')!
      const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
      g.addColorStop(0, 'rgba(255,255,250,1)')
      g.addColorStop(0.25, 'rgba(255,247,220,0.9)')
      g.addColorStop(0.6, 'rgba(255,240,200,0.28)')
      g.addColorStop(1, 'rgba(255,240,200,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 256, 256)
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      return tex
    })()
    const sunMat = new THREE.SpriteMaterial({ map: sunTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })
    const sun = new THREE.Sprite(sunMat)
    sun.position.copy(sunDir).multiplyScalar(330)
    sun.scale.setScalar(120)
    scene.add(sun)
    const haloMat = sunMat.clone()
    haloMat.opacity = 0.5
    const halo = new THREE.Sprite(haloMat)
    halo.position.copy(sun.position)
    halo.scale.setScalar(300)
    scene.add(halo)

    // -------------------------------------------------------------- lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const hemi = new THREE.HemisphereLight(0xd9ecff, 0x9db8d4, 0.95)
    scene.add(hemi)
    const dir = new THREE.DirectionalLight(0xfff2da, 2.1)
    dir.position.copy(sunDir).multiplyScalar(100)
    scene.add(dir)

    // -------------------------------------------------------------- clouds
    const cloudGeo = new THREE.SphereGeometry(1, 14, 11)
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      emissive: 0xffffff,
      emissiveIntensity: 0.06,
    })
    interface Drifter { g: THREE.Group; speed: number }
    const drifters: Drifter[] = []
    const mkCloud = (scale: number, puffs = 8) => {
      const g = new THREE.Group()
      for (let i = 0; i < puffs; i++) {
        const m = new THREE.Mesh(cloudGeo, cloudMat)
        m.position.set((Math.random() - 0.5) * 2.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.6)
        const r = 0.5 + Math.random() * 0.7
        m.scale.set(r, r * 0.62, r)
        g.add(m)
      }
      g.scale.setScalar(scale)
      g.scale.y *= 0.62
      return g
    }
    for (let i = 0; i < 15; i++) {
      const g = mkCloud(1.6 + Math.random() * 2.6, 7 + Math.floor(Math.random() * 5))
      const ang = Math.random() * Math.PI * 2
      const rad = 26 + Math.random() * 60
      g.position.set(Math.cos(ang) * rad, -7 + Math.random() * 20, Math.sin(ang) * rad)
      scene.add(g)
      drifters.push({ g, speed: 0.5 + Math.random() * 1.1 })
    }
    // cloud floor far below — sells the altitude
    for (let i = 0; i < 4; i++) {
      const g = mkCloud(9 + Math.random() * 5, 12)
      g.position.set(-60 + i * 42 + Math.random() * 18, -15 - Math.random() * 4, -30 + Math.random() * 60)
      scene.add(g)
      drifters.push({ g, speed: 0.3 + Math.random() * 0.3 })
    }

    // ----------------------------------------------------------------- car
    const car = new THREE.Group()
    const paint = new THREE.MeshPhysicalMaterial({
      color: 0xc21f1f,
      metalness: 0.72,
      roughness: 0.28,
      clearcoat: 1,
      clearcoatRoughness: 0.18,
    })
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x0d1620,
      metalness: 0.5,
      roughness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    })

    // body — extruded side profile (nose → hood → windshield → roof → tail)
    const bodyShape = new THREE.Shape()
    bodyShape.moveTo(-2.05, 0.1)
    bodyShape.lineTo(-2.16, 0.56)
    bodyShape.quadraticCurveTo(-1.7, 0.74, -1.15, 0.7)
    bodyShape.quadraticCurveTo(-0.75, 0.93, -0.25, 0.95)
    bodyShape.quadraticCurveTo(0.28, 0.93, 0.62, 0.7)
    bodyShape.quadraticCurveTo(1.35, 0.62, 1.95, 0.54)
    bodyShape.quadraticCurveTo(2.22, 0.48, 2.2, 0.32)
    bodyShape.lineTo(2.1, 0.1)
    bodyShape.closePath()
    const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
      depth: 1.5,
      bevelEnabled: true,
      bevelThickness: 0.09,
      bevelSize: 0.09,
      bevelSegments: 4,
      steps: 1,
    })
    bodyGeo.translate(0, 0, -0.75)
    car.add(new THREE.Mesh(bodyGeo, paint))

    // glass canopy — slightly proud of the roofline
    const glassShape = new THREE.Shape()
    glassShape.moveTo(-1.18, 0.66)
    glassShape.quadraticCurveTo(-0.78, 1.06, -0.28, 1.08)
    glassShape.quadraticCurveTo(0.3, 1.04, 0.7, 0.66)
    glassShape.closePath()
    const glassGeo = new THREE.ExtrudeGeometry(glassShape, {
      depth: 1.3,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 3,
      steps: 1,
    })
    glassGeo.translate(0, 0, -0.65)
    car.add(new THREE.Mesh(glassGeo, glass))

    // wheels — tire + rim + spokes (they spin slowly; faster on boost)
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.92 })
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xd9dce2, metalness: 0.9, roughness: 0.24 })
    const tireGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.27, 26)
    const rimGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.36, 22) // caps proud of the tire sidewall
    const spokeGeo = new THREE.BoxGeometry(0.4, 0.05, 0.3)
    const wheels: THREE.Group[] = []
    for (const [wx, wz] of [
      [1.34, 0.82],
      [1.34, -0.82],
      [-1.34, 0.82],
      [-1.34, -0.82],
    ]) {
      const w = new THREE.Group()
      const tire = new THREE.Mesh(tireGeo, tireMat)
      tire.rotation.x = Math.PI / 2
      const rim = new THREE.Mesh(rimGeo, rimMat)
      rim.rotation.x = Math.PI / 2
      w.add(tire, rim)
      for (let s = 0; s < 3; s++) {
        const sp = new THREE.Mesh(spokeGeo, rimMat)
        sp.rotation.z = (s * Math.PI) / 3
        w.add(sp)
      }
      w.position.set(wx, 0.4, wz)
      car.add(w)
      wheels.push(w)
    }

    // lights & thrusters
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.2 })
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 2.6 })
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 1.15), headMat)
    head.position.set(2.24, 0.36, 0)
    car.add(head)
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 1.35), tailMat)
    tail.position.set(-2.2, 0.5, 0)
    car.add(tail)

    const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x06343a, emissive: 0x22d3ee, emissiveIntensity: 2.6 })
    const flameMat = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const nozzleGeo = new THREE.CylinderGeometry(0.17, 0.15, 0.14, 18)
    const flameGeo = new THREE.ConeGeometry(0.16, 1.5, 16, 1, true)
    const flames: THREE.Mesh[] = []
    for (const [tx, tz] of [
      [1.3, 0.42],
      [1.3, -0.42],
      [-1.1, 0.5],
      [-1.1, -0.5],
    ]) {
      const n = new THREE.Mesh(nozzleGeo, nozzleMat)
      n.position.set(tx, 0.02, tz)
      car.add(n)
      const f = new THREE.Mesh(flameGeo, flameMat.clone())
      f.rotation.x = Math.PI // apex down
      f.position.set(tx, -0.85, tz)
      car.add(f)
      flames.push(f)
    }
    const thrusterLight = new THREE.PointLight(0x22d3ee, 7, 8, 1.6)
    thrusterLight.position.set(0, -0.4, 0)
    car.add(thrusterLight)

    // underglow sprite
    const glowTex = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 128
      const ctx = c.getContext('2d')!
      const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
      g.addColorStop(0, 'rgba(103,232,249,0.75)')
      g.addColorStop(1, 'rgba(103,232,249,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 128, 128)
      return new THREE.CanvasTexture(c)
    })()
    const glowMat = new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 })
    const underglow = new THREE.Sprite(glowMat)
    underglow.scale.set(4.6, 1.7, 1)
    underglow.position.y = -0.55
    car.add(underglow)

    scene.add(car)

    // -------------------------------------------------------- speed streaks
    const streakGeo = new THREE.BoxGeometry(2.6, 0.02, 0.02)
    const streakMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    const streaks: THREE.Mesh[] = []
    for (let i = 0; i < 26; i++) {
      const s = new THREE.Mesh(streakGeo, streakMat)
      s.position.set((Math.random() - 0.5) * 14, (Math.random() - 0.3) * 6, (Math.random() - 0.5) * 10)
      scene.add(s)
      streaks.push(s)
    }

    // ------------------------------------------------------------- controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.6, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.enablePan = false
    controls.minDistance = 5.5
    controls.maxDistance = 20
    controls.maxPolarAngle = 1.48
    controls.minPolarAngle = 0.35
    controls.autoRotateSpeed = 0.55
    let userHold = false
    let lastInteract = 0
    controls.addEventListener('start', () => {
      userHold = true
      lastInteract = performance.now()
      setHintGone(true)
    })
    controls.addEventListener('end', () => {
      userHold = false
      lastInteract = performance.now()
    })

    // -------------------------------------------------- pointer interaction
    const pointerNdc = new THREE.Vector2(0, 0)
    let downAt: { x: number; y: number } | null = null
    const raycaster = new THREE.Raycaster()
    let boost = 0
    const onPointerMove = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect()
      pointerNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1
      pointerNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1
    }
    const onPointerDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY }
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!downAt) return
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y)
      downAt = null
      if (moved > 7 || reduced) return
      const r = renderer.domElement.getBoundingClientRect()
      raycaster.setFromCamera(
        new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
        camera,
      )
      if (raycaster.intersectObject(car, true).length > 0) {
        boost = 1
        setHintGone(true)
      }
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    // hint auto-fade
    const hintTimer = window.setTimeout(() => setHintGone(true), 9000)

    // ----------------------------------------------------------- main loop
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth || 640
      const h = host.clientHeight || 360
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    ro.observe(host)

    const clock = new THREE.Clock()
    let raf = 0
    let running = true
    const tick = () => {
      if (!running) return
      raf = requestAnimationFrame(tick)
      const dt = Math.min(clock.getDelta(), 0.05)
      const t = clock.elapsedTime

      // clouds drift + wrap
      for (const d of drifters) {
        d.g.position.x += d.speed * dt
        if (d.g.position.x > 105) d.g.position.x = -105
      }

      boost = Math.max(0, boost - dt * 1.15)

      // hover + pointer bank + boost
      const hoverY = reduced ? 0 : Math.sin(t * 1.35) * 0.16
      const targetRoll = -pointerNdc.x * 0.16
      const targetYaw = pointerNdc.x * 0.24
      const targetPitch = pointerNdc.y * 0.07 - boost * 0.14
      car.rotation.z += (targetRoll - car.rotation.z) * Math.min(1, dt * 3)
      car.rotation.y += (targetYaw - car.rotation.y) * Math.min(1, dt * 3)
      car.rotation.x += (targetPitch - car.rotation.x) * Math.min(1, dt * 3)
      car.position.y = hoverY + boost * 0.85 + Math.sin(t * 0.7) * 0.05

      // thrusters breathe; flare on boost
      for (let i = 0; i < flames.length; i++) {
        const f = flames[i]
        const pulse = 0.85 + 0.2 * Math.sin(t * 7 + i * 1.7)
        f.scale.set(1 + boost * 0.7, pulse + boost * 2.6, 1 + boost * 0.7)
        f.material.opacity = 0.16 + boost * 0.35
      }
      nozzleMat.emissiveIntensity = 2.4 + boost * 7
      thrusterLight.intensity = 7 + boost * 26
      underglow.material.opacity = 0.5 + boost * 0.4

      // wheels idle-spin, spin hard on boost
      for (const w of wheels) w.rotation.z -= dt * (0.9 + boost * 14)

      // speed streaks only visible while boosted
      streakMat.opacity = boost * 0.4
      if (boost > 0.02) {
        for (const s of streaks) {
          s.position.x -= dt * (16 + boost * 22)
          if (s.position.x < -10) {
            s.position.x = 10 + Math.random() * 4
            s.position.y = (Math.random() - 0.3) * 6
            s.position.z = (Math.random() - 0.5) * 10
          }
        }
      }

      controls.autoRotate = !reduced && !userHold && performance.now() - lastInteract > 3500
      controls.update()
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(tick)

    const onVis = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running) {
        running = true
        clock.getDelta()
        raf = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVis)

    // -------------------------------------------------------------- cleanup
    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.clearTimeout(hintTimer)
      document.removeEventListener('visibilitychange', onVis)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      ro.disconnect()
      controls.dispose()
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else if (m) m.dispose()
      })
      sunTex.dispose()
      glowTex.dispose()
      renderer.dispose()
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement)
    }
  }, [])

  if (failed) {
    // WebGL unavailable — static bright-sky gradient so the hero still reads
    return (
      <div
        aria-hidden
        className="flex h-full w-full items-center justify-center text-6xl"
        style={{ background: 'linear-gradient(to top, #dff0fd 0%, #8ec3ee 45%, #2f7fd4 100%)' }}
      >
        <span style={{ filter: 'drop-shadow(0 12px 18px rgba(0,0,0,0.25))' }}>🚗☁️</span>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" aria-label="Interactive 3D sky with a flying sports car — drag to orbit, scroll to zoom, click the car to boost" role="img" />
      <div
        aria-hidden
        className={`pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/40 px-3 py-1.5 text-[10px] font-medium tracking-wide text-white/85 backdrop-blur-sm transition-opacity duration-700 sm:text-[11px] ${
          hintGone ? 'opacity-0' : 'opacity-100'
        }`}
      >
        Drag to orbit · scroll to zoom · click the car to boost
      </div>
    </div>
  )
}
