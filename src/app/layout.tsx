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
