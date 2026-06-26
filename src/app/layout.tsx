import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Rental Manager v2",
  description: "Rental dashboard — DB Cinema + Leo Adams",
  // PWA: enables "Add to Home Screen" (required for iOS web push) + installable
  // app on Android, so push notifications can be delivered to the phone.
  manifest: "/manifest.webmanifest",
  applicationName: "Rental Manager",
  // Blue Aputure mark. iOS shows the apple-touch-icon (NOT a per-notification
  // icon) on push, so this is what makes an iPhone notification recognisable.
  icons: {
    icon: [
      { url: "/app-icon.svg", type: "image/svg+xml" },
      { url: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/app-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Rentals",
  },
};

export const viewport: Viewport = {
  themeColor: "#070910",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
