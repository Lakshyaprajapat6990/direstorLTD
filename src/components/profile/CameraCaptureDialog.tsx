"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CAMERA_MESSAGES, cameraSupport, classifyCameraError } from "@/lib/camera";

// Opens the device camera with getUserMedia (only when this dialog is opened by a click), shows a live preview, captures one still,
// lets the person retake or confirm it, and hands the confirmed image to the existing profile-picture pipeline (validation,
// square crop, downscale, upload). The camera is switched off on EVERY way out: capture, retake, cancel, Escape, an error,
// closing, and the page navigating away (unmount).
type Phase = "starting" | "live" | "captured" | "error";

export function CameraCaptureDialog({ onClose, onUse }: { onClose: () => void; onUse: (file: File) => void }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const aliveRef = useRef(true);
  const runRef = useRef(0); // identifies the latest start, so a stale permission prompt can never take over

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async () => {
    const run = ++runRef.current;
    const problem = cameraSupport({ isSecureContext: window.isSecureContext, hasMediaDevices: !!navigator.mediaDevices?.getUserMedia });
    if (problem) {
      setMessage(CAMERA_MESSAGES[problem]);
      setPhase("error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      if (!aliveRef.current || run !== runRef.current) {
        // Closed (or restarted) while the permission prompt was open: do not leave this camera running.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      setPhase("live");
    } catch (err) {
      if (!aliveRef.current || run !== runRef.current) return;
      stopCamera();
      setMessage(CAMERA_MESSAGES[classifyCameraError(err)]);
      setPhase("error");
    }
  }, [stopCamera]);

  useEffect(() => {
    aliveRef.current = true;
    // Started from a timer (not synchronously in the effect body); the cleanup cancels it, so a development double-mount never starts twice.
    const t = setTimeout(() => void startCamera(), 0);
    return () => {
      clearTimeout(t);
      aliveRef.current = false;
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  useEffect(() => {
    const url = shot?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [shot]);

  const close = useCallback(() => {
    stopCamera();
    onClose();
  }, [onClose, stopCamera]);

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        stopCamera(); // the still is taken: the camera is no longer needed
        if (!blob) {
          setMessage(CAMERA_MESSAGES.other);
          setPhase("error");
          return;
        }
        setShot({ blob, url: URL.createObjectURL(blob) });
        setPhase("captured");
      },
      "image/jpeg",
      0.92
    );
  }

  function restart() {
    setShot(null);
    setMessage(null);
    setPhase("starting");
    void startCamera();
  }

  function use() {
    if (!shot) return;
    stopCamera();
    onUse(new File([shot.blob], "camera.jpg", { type: "image/jpeg" }));
    onClose();
  }

  // Keyboard: Escape closes; Tab stays inside the dialog.
  useEffect(() => {
    const el = dialogRef.current;
    el?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>("button:not([disabled])")];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, phase]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="camera-title" className="w-full max-w-md overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 id="camera-title" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Camera className="h-4 w-4 text-indigo-600" aria-hidden /> Take a photo
          </h2>
          <button type="button" onClick={close} aria-label="Close camera" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 focus-ring">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="p-4">
          <div className="relative aspect-square overflow-hidden rounded-xl bg-slate-900">
            <video ref={videoRef} playsInline muted autoPlay aria-label="Live camera preview" className={`h-full w-full -scale-x-100 object-cover ${phase === "live" ? "" : "invisible"}`} />
            {phase === "captured" && shot && (
              // eslint-disable-next-line @next/next/no-img-element -- a local blob preview, not an optimisable asset
              <img src={shot.url} alt="Your captured photo" className="absolute inset-0 h-full w-full -scale-x-100 object-cover" />
            )}
            {phase === "starting" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-200" role="status">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                Waiting for camera permission…
              </div>
            )}
            {phase === "error" && (
              <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-slate-100" role="alert">
                {message}
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {phase === "captured" ? "Happy with it? Use this photo, or retake it. Nothing is saved until you press Save picture." : "The picture is cropped to a square. The camera switches off as soon as you capture, cancel or close."}
          </p>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-4 py-3">
          {phase === "captured" ? (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={restart}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Retake
              </Button>
              <Button type="button" size="sm" onClick={use}>
                Use this photo
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              {phase === "error" ? (
                <Button type="button" variant="outline" size="sm" onClick={restart}>
                  Try again
                </Button>
              ) : (
                <Button type="button" size="sm" onClick={capture} disabled={phase !== "live"}>
                  <Camera className="h-4 w-4" aria-hidden /> Capture photo
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
