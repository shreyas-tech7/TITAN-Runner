"use client";

/**
 * God's Eye View-style WebGL globe (task brief, phase 3) — a lightweight,
 * dependency-minimal Three.js build rather than importing the full
 * CesiumJS-based github.com/bilawalsidhu/gods-eye-view application: that
 * project is built around public flight/ship/satellite/webcam data feeds
 * with its own large asset pipeline, which is a separate integration this
 * page does not attempt. What matters for this brief — a real WebGL 3D
 * globe that draws a pin (and a tracking path, for more than one point
 * from the same investigation) when a sub-agent resolves a location — is
 * implemented here directly against `events` from GET /geospatial/events.
 *
 * No texture assets: the globe is a wireframe sphere plus a procedural
 * lat/lon graticule, which keeps this a small, auditable dependency
 * (`three` alone) instead of bundling an earth texture.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { GeospatialEventRow } from "@/lib/workerApi";

const RADIUS = 2;

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
  const material = new THREE.LineBasicMaterial({ color: 0x3d7a63, transparent: true, opacity: 0.35 });
  return new THREE.LineSegments(geometry, material);
}

const CONFIDENCE_COLOR: Record<string, number> = {
  high: 0x5fb894, // --signal
  medium: 0xd9a441, // --warning
  low: 0xb5563c, // --failure
};

export default function GeospatialGlobe({ events }: { events: GeospatialEventRow[] }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const width = mount.clientWidth || 600;
    const height = 420;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x16181c); // --bg-0

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    camera.position.set(0, 0, 5.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.6;
    controls.minDistance = 3;
    controls.maxDistance = 12;

    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x232730, wireframe: true, transparent: true, opacity: 0.5 }),
    );
    scene.add(globe);
    scene.add(buildGraticule(RADIUS));

    const pinsGroup = new THREE.Group();
    scene.add(pinsGroup);

    // Pins, grouped by investigation so a repeated location resolution
    // (>1 event on the same investigation_id) draws a tracking path
    // between them in recorded_at order, not just disconnected dots.
    const located = events.filter((e) => typeof e.lat === "number" && typeof e.lon === "number");
    const byInvestigation = new Map<string, GeospatialEventRow[]>();
    for (const e of located) {
      const list = byInvestigation.get(e.investigation_id) ?? [];
      list.push(e);
      byInvestigation.set(e.investigation_id, list);
    }

    for (const rows of byInvestigation.values()) {
      const sorted = [...rows].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
      const points = sorted.map((e) => latLonToVector3(e.lat as number, e.lon as number, RADIUS * 1.01));

      for (let i = 0; i < sorted.length; i++) {
        const color = CONFIDENCE_COLOR[sorted[i].confidence ?? ""] ?? 0x5fb894;
        const pin = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), new THREE.MeshBasicMaterial({ color }));
        pin.position.copy(points[i]);
        pinsGroup.add(pin);
      }

      if (points.length > 1) {
        const pathGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const pathMaterial = new THREE.LineBasicMaterial({ color: 0xd9a441 });
        pinsGroup.add(new THREE.Line(pathGeometry, pathMaterial));
      }
    }

    let frameId = 0;
    function animate() {
      controls.update();
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    }
    animate();

    function handleResize() {
      if (!mount) return;
      const w = mount.clientWidth || 600;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
    }
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          const material = obj.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [events]);

  return <div ref={mountRef} style={{ width: "100%", height: 420, borderRadius: 4, overflow: "hidden" }} />;
}
