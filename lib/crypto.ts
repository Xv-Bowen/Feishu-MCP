import { AppError } from "./core";
const encoder = new TextEncoder();

export function randomString(size = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function key(hex: string) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new AppError("encryption_key_unavailable", "服务的授权保护配置尚未就绪，请联系创建此服务的助手修复。", 503);
  const bytes = Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(value: unknown, hex: string, owner: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(owner) }, await key(hex), encoder.encode(JSON.stringify(value)));
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function unseal<T>(value: string, hex: string, owner: string): Promise<T> {
  const [iv, encrypted] = value.split(".");
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv), additionalData: encoder.encode(owner) }, await key(hex), decode(encrypted));
  return JSON.parse(new TextDecoder().decode(data));
}
