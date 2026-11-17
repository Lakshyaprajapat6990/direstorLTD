"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Upload } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "@/components/ui/Button";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@/lib/site-content/image-info";
import type { MediaDTO } from "@/lib/site-content/media-store";
import { mediaSrc } from "@/lib/site-content/sections";

// Pick an uploaded image, or upload a new one (JPEG, PNG or WebP up to 2 MB; the server checks the file's real type and size).
export function MediaPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (m: MediaDTO) => void }) {
  const [items, setItems] = useState<MediaDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/admin/website-content/media");
    const json = await res.json().catch(() => ({}));
    if (res.ok) setItems(json.media as MediaDTO[]);
    else setError(json.error ?? `Could not load images (${res.status}).`);
  }, []);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to "loading" each time the dialog opens, then fetch the list
      setItems(null);
      void load();
    }
  }, [open, load]);

  async function upload(file: File) {
    setError(null);
    if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return setError("Choose a JPEG, PNG or WebP image.");
    if (file.size > MAX_IMAGE_BYTES) return setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/website-content/media", { method: "POST", headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name) }, body: file });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return setError(`${json.error ?? `Upload failed (${res.status}).`}${/migration/i.test(String(json.error)) ? " A developer needs to run `npm run db:migrate` on this database, then reload this page." : ""}`);
      onPick(json.media as MediaDTO);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Choose an image" size="lg">
      <div className="flex flex-wrap items-center gap-3">
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" id="media-upload" data-testid="media-upload" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <Button onClick={() => fileInput.current?.click()} disabled={busy}>
          <Upload className="h-4 w-4" aria-hidden /> {busy ? "Uploading and saving…" : "Upload a new image"}
        </Button>
        <p className="text-xs text-slate-500">JPEG, PNG or WebP, up to 2 MB. Add a description for people who cannot see the image.</p>
      </div>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <div className="mt-4">
        {items === null && !error && <p className="text-sm text-slate-500">Loading images…</p>}
        {items && items.length === 0 && (
          <p className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-6 text-sm text-slate-500">
            <ImagePlus className="h-5 w-5" aria-hidden /> No images yet. Upload your first one.
          </p>
        )}
        {items && items.length > 0 && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {items.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onPick(m)} className="group block w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-left hover:border-indigo-400 focus-ring" data-media-id={m.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- our own /media route */}
                  <img src={mediaSrc(m.id)} alt="" width={m.width} height={m.height} loading="lazy" className="aspect-[4/3] w-full bg-slate-50 object-cover" />
                  <span className="block truncate px-2 pt-1.5 text-xs font-medium text-slate-700">{m.originalName ?? "Image"}</span>
                  <span className="block px-2 pb-1.5 text-[11px] text-slate-400">
                    {m.width}×{m.height}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
