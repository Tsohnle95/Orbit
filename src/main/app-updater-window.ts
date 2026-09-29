import type { BrowserWindow } from "electron";

export interface AppUpdaterWindowStatus {
  title: string;
  message: string;
  tone?: "progress" | "success" | "error";
}

export function appUpdaterWindowDocument(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>Updating Orbit</title>
  <style>
    :root { color-scheme: dark; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111214; color: #f1f1f2; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 30px; }
    main { width: 100%; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
    .mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; background: linear-gradient(145deg, #a589ff, #7155dc); color: white; font-size: 22px; font-weight: 700; box-shadow: 0 6px 22px #7b5be44a; }
    .eyebrow { color: #aaa4c2; font-size: 10px; font-weight: 700; letter-spacing: .14em; margin: 0 0 4px; }
    h1 { font-size: 17px; font-weight: 600; letter-spacing: -.02em; margin: 0; }
    #message { color: #b5b4bc; line-height: 1.55; min-height: 40px; margin: 0 0 20px; overflow-wrap: anywhere; }
    .track { height: 3px; overflow: hidden; border-radius: 4px; background: #302d38; }
    .track span { display: block; width: 38%; height: 100%; border-radius: inherit; background: #a48aff; animation: progress 1.35s ease-in-out infinite alternate; }
    .track.success span { width: 100%; animation: none; background: #6bd6a2; }
    .track.error span { width: 100%; animation: none; background: #f17a78; }
    .foot { margin: 13px 0 0; color: #73717b; font-size: 11px; }
    @keyframes progress { from { transform: translateX(-55%); } to { transform: translateX(220%); } }
    @media (prefers-reduced-motion: reduce) { .track span { animation: none; } }
  </style>
</head>
<body>
  <main role="status" aria-live="polite">
    <div class="brand"><div class="mark" aria-hidden="true">O</div><div><p class="eyebrow">ORBIT UPDATE</p><h1 id="title">Preparing update…</h1></div></div>
    <p id="message">Checking the latest GitHub source.</p>
    <div class="track" id="track" aria-hidden="true"><span></span></div>
    <p class="foot" id="foot">Keep this window open while Orbit rebuilds.</p>
  </main>
  <script>
    window.setOrbitUpdaterStatus = (status) => {
      document.getElementById("title").textContent = status.title;
      document.getElementById("message").textContent = status.message;
      const track = document.getElementById("track");
      track.className = status.tone === "success" ? "track success" : status.tone === "error" ? "track error" : "track";
      document.getElementById("foot").textContent = status.tone === "error"
        ? "Close this window after reviewing the error, then retry when ready."
        : status.tone === "success" ? "Orbit is restarting with the updated build." : "Keep this window open while Orbit rebuilds.";
    };
  </script>
</body>
</html>`;
}

export function appUpdaterWindowUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(appUpdaterWindowDocument())}`;
}

export function setAppUpdaterWindowStatus(window: BrowserWindow, status: AppUpdaterWindowStatus): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const argument = JSON.stringify(status);
  void window.webContents.executeJavaScript(`window.setOrbitUpdaterStatus?.(${argument})`).catch(() => {});
}
