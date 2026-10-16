import type { Metadata } from "next";
import { SERVICE_DESCRIPTION } from "../lib/branding";
import "./globals.css";

export const metadata: Metadata = {
  title: "飞书",
  description: SERVICE_DESCRIPTION,
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png", sizes: "33x32" }, { url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
    shortcut: "/favicon.ico",
    apple: "/feishu-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
