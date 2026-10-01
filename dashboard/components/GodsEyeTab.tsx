"use client";

/**
 * The God's Eye View tab: the real open source 3D globe (TITAN-GEV, hosted on
 * a free Hugging Face Space), embedded as a full height iframe. The admin
 * token is already unlocked when this renders (AdminGate wraps the page), so
 * it asks the Worker for a short lived access link instead of storing one.
 * Lifecycle and retry live in `GevController`. This file only connects it to
 * React, the Worker, and the browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GevTabView from "@/components/GevTabView";
import {
  GevController,
  INITIAL_GEV_STATE,
  checkGevHealth,
  openGevFullScreen,
  parseGevMessage,
  parseGevUrl,
  toMintResult,
  type GevState,
  type MintResult,
} from "@/lib/gev";
import { fetchGevToken, isWorkerConfigured } from "@/lib/workerApi";

export default function GodsEyeTab({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const target = useMemo(() => parseGevUrl(process.env.NEXT_PUBLIC_GEV_URL), []);
  const origin = target.ok ? target.origin : null;
  const [state, setState] = useState<GevState>(INITIAL_GEV_STATE);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const controllerRef = useRef<GevController | null>(null);
  const tokenRef = useRef(token);
  const unauthorizedRef = useRef(onUnauthorized);
  tokenRef.current = token;
  unauthorizedRef.current = onUnauthorized;

  const mint = useCallback(async (): Promise<MintResult> => {
    if (!isWorkerConfigured()) return { kind: "not-configured", what: "worker" };
    try {
      const res = await fetchGevToken(tokenRef.current);
      return { kind: "ok", token: res.token };
    } catch (error) {
      return toMintResult(error);
    }
  }, []);

  useEffect(() => {
    const controller = new GevController({
      target,
      mint,
      checkHealth: (o) => checkGevHealth(o),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      onState: setState,
      onUnauthorized: () => unauthorizedRef.current(),
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      controller.stop();
      controllerRef.current = null;
    };
  }, [target, mint]);

  // The embedded page reports a blocked cookie or a 401 with postMessage.
  useEffect(() => {
    if (!origin) return;
    function onMessage(event: MessageEvent) {
      if (!origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = parseGevMessage(event, origin);
      if (message) controllerRef.current?.reportMessage(message);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);

  const onReload = useCallback(() => controllerRef.current?.reload(), []);
  const onOpenFullScreen = useCallback(() => {
    if (!origin) return;
    void openGevFullScreen({
      origin,
      mint,
      openBlank: () => window.open("", "_blank"),
    });
  }, [origin, mint]);

  return (
    <GevTabView
      state={state}
      origin={origin}
      frameRef={frameRef}
      onReload={onReload}
      onOpenFullScreen={onOpenFullScreen}
    />
  );
}
