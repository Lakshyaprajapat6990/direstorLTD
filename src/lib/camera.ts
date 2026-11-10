// Browser camera access for the profile picture. Pure helpers so the wording and the decision logic can be unit tested.

export type CameraProblem = "unsupported" | "insecure" | "denied" | "none" | "busy" | "other";

// Why the camera cannot be started, from what the browser reports (nothing here starts the camera).
export function cameraSupport(env: { isSecureContext?: boolean; hasMediaDevices: boolean }): CameraProblem | null {
  if (env.isSecureContext === false) return "insecure";
  if (!env.hasMediaDevices) return "unsupported";
  return null;
}

export function classifyCameraError(err: unknown): CameraProblem {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "none";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "other";
}

export const CAMERA_MESSAGES: Record<CameraProblem, string> = {
  insecure: "The camera only works on a secure (HTTPS) connection. Use “Upload / choose from gallery” instead.",
  unsupported: "This browser cannot open a camera from a web page. Use “Upload / choose from gallery” instead.",
  denied: "Camera access was blocked. Allow the camera for this site in your browser settings and try again, or use “Upload / choose from gallery”.",
  none: "No camera was found on this device. Use “Upload / choose from gallery” instead.",
  busy: "The camera is in use by another app or could not be started. Close the other app and try again, or use “Upload / choose from gallery”.",
  other: "The camera could not be started. Try again, or use “Upload / choose from gallery”.",
};
