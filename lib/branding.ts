// Original project icon, MIT licensed; no official logo or personal avatar.
export const SERVICE_DESCRIPTION = "把飞书接入AI助手。";
export const SERVER_INFO = {
  "name": "feishu-documents",
  "version": "0.9.8",
  "title": "飞书",
  "description": SERVICE_DESCRIPTION,
  "icons": [{ "src": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMyIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMzIDMyIj48cmVjdCB4PSIuNSIgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzIzNWRlMyIvPjxwYXRoIGQ9Ik0xMCAxMmg5YTQgNCAwIDAgMSAwIDhoLTNNMjMgMjBoLTlhNCA0IDAgMCAxIDAtOGgzIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+", "mimeType": "image/svg+xml", "sizes": ["any"] }]
};

export function serverInfo(siteOrigin?: string) {
  if (!siteOrigin) return SERVER_INFO;
  const base = new URL(siteOrigin).origin;
  return { ...SERVER_INFO, websiteUrl: base, icons: [{ src: `${base}/feishu-icon.png`, mimeType: "image/png", sizes: ["33x32"] }] };
}
