"use client";

/**
 * The God's Eye View globe. A lightweight, dependency-minimal Three.js
 * build (`three` + its bundled `OrbitControls` example, no CesiumJS, no
 * texture assets — a wireframe sphere plus a procedural graticule) rather
 * than importing a large external globe application.
 *
 * Root cause this rewrite fixes: the previous version tore the entire
 * WebGL scene down and rebuilt it — new renderer, new camera at its
 * default position, new controls — inside a `useEffect` keyed on `events`.
 * `fetchGeospatialEvents` returns a brand-new array on every 20s poll tick
 * even when nothing changed, so the whole globe silently reset itself
 * (camera snapped back, any zoom/rotation the viewer had was thrown away)
 * every 20 seconds. That is why it only ever "appeared" rather than
 * working: a viewer could never actually interact with it for more than a
 * few seconds. The fix is to separate concerns into two effects — scene/
 * camera/renderer/controls are created exactly once and never rebuilt, and
 * a second effect (keyed on a content *signature*, not the array identity)
 * only replaces the pins/arcs group when the underlying data has actually
 * changed.
 *
 * It is also no longer solely dependent on the optional titan-runner-brain
 * Worker: `networkNodes` (TITAN's provider mesh, derived from
 * `state/providers.json` — always present, no deployment required) keeps
 * the globe populated and alive even before any OSINT investigation has
 * ever resolved a coordinate. Those investigation pins, when the Worker
 * *is* configured and has data, are overlaid on top of the same globe.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GeospatialEventRow } from "@/lib/workerApi";

const RADIUS = 2;

export type NodeStatus = "online" | "warning" | "offline" | "idle";

export interface NetworkNode {
  id: string;
  label: string;
  lat: number;
  lon: number;
  status: NodeStatus;
  detail: string;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  detail: string;
}

function latLonToVector3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function buildGraticule(radius: number): THREE.LineSegments {
  const points: THREE.Vector3[] = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -180; lon < 180; lon += 5) {
      points.push(latLonToVector3(lat, lon, radius), latLonToVector3(lat, lon + 5, radius));
    }
  }
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -90; lat < 90; lat += 5) {
      points.push(latLonToVector3(lat, lon, radius), latLonToVector3(lat + 5, lon, radius));
    }
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: 0x3d7a63, transparent: true, opacity: 0.28 });
  return new THREE.LineSegments(geometry, material);
}

const CONFIDENCE_COLOR: Record<string, number> = {
  high: 0x5fb894, // --signal
  medium: 0xd9a441, // --warning
  low: 0xb5563c, // --failure
};

const NODE_STATUS_COLOR: Record<NodeStatus, number> = {
  online: 0x5fb894,
  warning: 0xd9a441,
  offline: 0xb5563c,
  idle: 0x6d7278,
};

const ACCENT = 0x5aa9e6;
const HOME = { lat: 32.7767, lon: -96.797, label: "Command Center — Dallas, TX" };

interface Pulse {
  curve: THREE.QuadraticBezierCurve3;
  mesh: THREE.Mesh;
  speed: number;
  phase: number;
}

interface Pickable {
  object: THREE.Object3D;
  title: string;
  detail: string;
}

/** A short, order-independent fingerprint of the data actually shown on the
 * globe — used as the pin-rebuild effect's dependency instead of the raw
 * arrays, so a poll tick that returns identical content never touches the
 * scene at all. */
function signatureOf(events: GeospatialEventRow[], nodes: NetworkNode[]): string {
  const e = events.map((ev) => `${ev.id}:${ev.lat}:${ev.lon}:${ev.confidence}`).join(",");
  const n = nodes.map((n) => `${n.id}:${n.status}`).join(",");
  return `${e}|${n}`;
}

export default function GeospatialGlobe({ events, networkNodes }: { events: GeospatialEventRow[]; networkNodes: NetworkNode[] }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pinsGroupRef = useRef<THREE.Group | null>(null);
  const pulsesRef = useRef<Pulse[]>([]);
  const pickablesRef = useRef<Pickable[]>([]);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const signature = useMemo(() => signatureOf(events, networkNodes), [events, networkNodes]);

  // Effect A — scene/camera/renderer/controls, created exactly once and
  // disposed exactly once. Never re-runs on a data poll.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5.5);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.minDistance = 2.8;
    controls.maxDistance = 11;
    controlsRef.current = controls;
    // Pause the ambient rotation while a viewer is actually driving the
    // camera — resuming it afterward is what makes the interaction feel
    // deliberate rather than fighting the auto-spin the whole time.
    controls.addEventListener("start", () => {
      controls.autoRotate = false;
    });
    controls.addEventListener("end", () => {
      window.setTimeout(() => {
        controls.autoRotate = true;
      }, 4000);
    });

    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 40, 40),
      new THREE.MeshBasicMaterial({ color: 0x232730, wireframe: true, transparent: true, opacity: 0.45 }),
    );
    scene.add(globe);

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS * 0.988, 40, 40),
      new THREE.MeshBasicMaterial({ color: 0x16181c, transparent: true, opacity: 0.85 }),
    );
    scene.add(core);

    scene.add(buildGraticule(RADIUS));

    const pinsGroup = new THREE.Group();
    pinsGroupRef.current = pinsGroup;
    scene.add(pinsGroup);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function handlePointerMove(ev: PointerEvent) {
      const rect = mount!.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const objects = pickablesRef.current.map((p) => p.object);
      const hits = objects.length ? raycaster.intersectObjects(objects, false) : [];
      if (hits.length > 0) {
        const hit = pickablesRef.current.find((p) => p.object === hits[0].object);
        if (hit) {
          setTooltip({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, title: hit.title, detail: hit.detail });
          renderer.domElement.style.cursor = "pointer";
          return;
        }
      }
      setTooltip(null);
      renderer.domElement.style.cursor = "grab";
    }
    function handlePointerLeave() {
      setTooltip(null);
    }
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);

    let frameId = 0;
    const clock = new THREE.Clock();
    function animate() {
      const t = clock.getElapsedTime();
      controls.update();
      for (const pulse of pulsesRef.current) {
        const tt = (t * pulse.speed + pulse.phase) % 1;
        pulse.mesh.position.copy(pulse.curve.getPoint(tt));
        const mat = pulse.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = tt < 0.08 || tt > 0.92 ? 0 : 1;
      }
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    }
    animate();

    function applySize(width: number, height: number) {
      if (width <= 0 || height <= 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }
    applySize(mount.clientWidth || 600, mount.clientHeight || 420);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      applySize(width, height);
    });
    resizeObserver.observe(mount);

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          const material = obj.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      pinsGroupRef.current = null;
    };
    // Intentionally empty — this effect owns the WebGL lifecycle and must
    // run exactly once per mount, never re-triggered by a data poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effect B — replaces only the pins/nodes/arcs group's children, keyed on
  // a content signature rather than array identity. Camera/controls are
  // never touched here, so a viewer's rotation/zoom survives every poll.
  useEffect(() => {
    const pinsGroup = pinsGroupRef.current;
    if (!pinsGroup) return;

    while (pinsGroup.children.length > 0) {
      const child = pinsGroup.children.pop()!;
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    }
    pulsesRef.current = [];
    const pickables: Pickable[] = [];

    const homePos = latLonToVector3(HOME.lat, HOME.lon, RADIUS * 1.01);
    const home = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), new THREE.MeshBasicMaterial({ color: ACCENT }));
    home.position.copy(homePos);
    pinsGroup.add(home);
    const homeRing = new THREE.Mesh(
      new THREE.RingGeometry(0.075, 0.095, 24),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    homeRing.position.copy(homePos);
    homeRing.lookAt(homePos.clone().multiplyScalar(2));
    pinsGroup.add(homeRing);
    pickables.push({ object: home, title: HOME.label, detail: "TITAN-Runner's operator base — the fixed reference point for the network mesh below." });

    // Provider/agent network mesh — always present, derived from
    // state/providers.json, so the globe has real live content even with
    // no Worker deployed and no OSINT investigation ever run.
    for (const node of networkNodes) {
      const pos = latLonToVector3(node.lat, node.lon, RADIUS * 1.01);
      const color = NODE_STATUS_COLOR[node.status];
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.04, 14, 14), new THREE.MeshBasicMaterial({ color }));
      mesh.position.copy(pos);
      pinsGroup.add(mesh);
      pickables.push({ object: mesh, title: node.label, detail: node.detail });

      if (node.status === "online") {
        const mid = homePos.clone().add(pos).multiplyScalar(0.5).normalize().multiplyScalar(RADIUS * 1.35);
        const curve = new THREE.QuadraticBezierCurve3(homePos, mid, pos);
        const arcGeometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(48));
        const arcMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3 });
        pinsGroup.add(new THREE.Line(arcGeometry, arcMaterial));

        const pulseMesh = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 10), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true }));
        pinsGroup.add(pulseMesh);
        pulsesRef.current.push({ curve, mesh: pulseMesh, speed: 0.12, phase: Math.random() });
      }
    }

    // OSINT investigation pins — real, resolved coordinates from
    // GET /geospatial/events, grouped by investigation so a repeated
    // location resolution draws a tracking path in recorded_at order.
    const located = events.filter((e) => typeof e.lat === "number" && typeof e.lon === "number");
    const byInvestigation = new Map<string, GeospatialEventRow[]>();
    for (const e of located) {
      const list = byInvestigation.get(e.investigation_id) ?? [];
      list.push(e);
      byInvestigation.set(e.investigation_id, list);
    }
    for (const rows of byInvestigation.values()) {
      const sorted = [...rows].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
      const points = sorted.map((e) => latLonToVector3(e.lat as number, e.lon as number, RADIUS * 1.015));

      for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i];
        const color = CONFIDENCE_COLOR[row.confidence ?? ""] ?? 0x5fb894;
        const pin = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 12), new THREE.MeshBasicMaterial({ color }));
        pin.position.copy(points[i]);
        pinsGroup.add(pin);
        pickables.push({
          object: pin,
          title: row.label,
          detail: `OSINT investigation · confidence: ${row.confidence ?? "unknown"}${row.ip ? ` · ${row.ip}` : ""}`,
        });
      }
      if (points.length > 1) {
        const pathGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const pathMaterial = new THREE.LineBasicMaterial({ color: 0xd9a441 });
        pinsGroup.add(new THREE.Line(pathGeometry, pathMaterial));
      }
    }

    pickablesRef.current = pickables;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (
    <div ref={mountRef} className="globe-canvas-mount">
      {tooltip && (
        <div className="globe-tooltip" style={{ left: tooltip.x, top: tooltip.y }} role="tooltip">
          <div className="label" style={{ color: "var(--text-0)" }}>
            {tooltip.title}
          </div>
          <div className="text-quiet">{tooltip.detail}</div>
        </div>
      )}
    </div>
  );
}
