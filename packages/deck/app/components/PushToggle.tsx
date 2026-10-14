/**
 * PushToggle.tsx - "enable notifications on this device" affordance.
 *
 * Lives in the bell dropdown (the notification surface). Four states:
 *   - unsupported: no serviceWorker/PushManager/Notification -> render nothing
 *   - denied: the browser has push blocked -> inert hint
 *   - subscribed: tap to turn off (unsubscribe + tell the server)
 *   - off: tap to enable (register SW -> permission -> subscribe -> POST)
 *
 * The VAPID public key is fetched from /api/push-subscribe on demand - no
 * loader plumbing, and the key is lazily self-provisioned server-side on
 * the first ask. This component touches no env/fs.
 *
 * iOS caveat (surfaced in the hint): web push only fires for sites added
 * to the Home Screen (16.4+), never from a plain Safari tab.
 *
 * ASCII only - no em-dashes.
 */
import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";

type PushState = "unsupported" | "denied" | "subscribed" | "off" | "busy";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function PushToggle() {
  const [state, setState] = useState<PushState>("unsupported");

  useEffect(() => {
    if (!pushSupported()) return;
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        if (!cancelled) setState(sub ? "subscribed" : "off");
      } catch {
        if (!cancelled) setState("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const keyRes = await fetch("/api/push-subscribe");
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      const res = await fetch("/api/push-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "subscribe", subscription: sub.toJSON() }),
      });
      setState(res.ok ? "subscribed" : "off");
    } catch {
      setState("off");
    }
  }

  async function disable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch("/api/push-subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent: "unsubscribe", endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
    } catch {
      setState("off");
    }
  }

  if (state === "unsupported") return null;

  if (state === "denied") {
    return (
      <div
        data-testid="push-toggle"
        data-push-state="denied"
        className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
      >
        <BellOff className="size-3.5 shrink-0" aria-hidden="true" />
        <span>Notifications blocked in browser settings</span>
      </div>
    );
  }

  if (state === "subscribed") {
    return (
      <button
        type="button"
        data-testid="push-toggle"
        data-push-state="subscribed"
        onClick={disable}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground/80 hover:bg-muted"
      >
        <BellRing className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span>Notifications on for this device - tap to turn off</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid="push-toggle"
      data-push-state={state}
      disabled={state === "busy"}
      onClick={enable}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground/80 hover:bg-muted disabled:opacity-50"
    >
      <Bell className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {state === "busy" ? "Setting up..." : "Enable notifications on this device"}
      </span>
    </button>
  );
}
