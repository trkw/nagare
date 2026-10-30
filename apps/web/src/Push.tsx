import { useEffect, useState } from "react";
import { api } from "./api";

const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "";
  return `${browser}${os ? ` (${os})` : ""}`;
}

/** Turns Web Push on or off for this browser. Which feeds notify is set per feed. */
export function PushToggle({ onError }: { onError: (msg: string) => void }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    api
      .pushConfig()
      .then(async (cfg) => {
        if (!cfg.webpush || !cfg.webpush_public_key) return;
        setPublicKey(cfg.webpush_public_key);
        const reg = await navigator.serviceWorker.register("/sw.js");
        setSubscription(await reg.pushManager.getSubscription());
      })
      .catch(() => undefined);
  }, []);

  if (!supported || !publicKey) return null;

  async function enable() {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== "granted") throw new Error("通知が許可されませんでした");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey!) });
      const keys = sub.toJSON().keys as { p256dh: string; auth: string };
      await api.registerPush({ platform: "webpush", token: sub.endpoint, keys, name: deviceName() });
      setSubscription(sub);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!subscription) return;
    setBusy(true);
    try {
      await api.unregisterPush(subscription.endpoint);
      await subscription.unsubscribe();
      setSubscription(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    try {
      const r = await api.testPush();
      if (r.sent === 0) onError(r.failed ? "送信に失敗しました" : "通知を受け取る端末がありません");
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return subscription ? (
    <span className="push-toggle">
      <button className="link" disabled={busy} onClick={disable}>
        このブラウザの通知をオフ
      </button>
      <button className="link" onClick={test}>
        テスト
      </button>
    </span>
  ) : (
    <button className="link" disabled={busy} onClick={enable}>
      このブラウザで通知を受け取る
    </button>
  );
}
