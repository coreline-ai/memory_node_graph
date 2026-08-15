import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const configuredOrigin = process.env.ATLAS_APP_ORIGIN?.trim();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.trim();
  const candidateProtocol = forwardedProtocol === "https" ? "https" : "http";
  const candidate = (() => {
    try {
      return new URL(`${candidateProtocol}://${host}`);
    } catch {
      return null;
    }
  })();
  const localHost = candidate
    && new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(candidate.hostname);
  const configured = (() => {
    try {
      if (!configuredOrigin) return null;
      const url = new URL(configuredOrigin);
      return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  })();
  const baseUrl = (configured ?? (localHost ? candidate : null) ?? new URL("http://localhost:3000")).origin;

  return {
    metadataBase: new URL(baseUrl),
    title: {
      default: "AI Systems Atlas",
      template: "%s · AI Systems Atlas",
    },
    description:
      "AI 시스템의 개념과 관계를 빛나는 3D 별자리로 탐색하는 지식 그래프 데모.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "AI Systems Atlas",
      description: "관계로 탐색하는 AI 지식 우주",
      type: "website",
      locale: "ko_KR",
      images: [
        {
          url: `${baseUrl}/og.png`,
          width: 1200,
          height: 630,
          alt: "AI Systems Atlas — 관계로 탐색하는 AI 지식 우주",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "AI Systems Atlas",
      description: "관계로 탐색하는 AI 지식 우주",
      images: [`${baseUrl}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
