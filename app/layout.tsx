import type { Metadata } from "next"
import Script from "next/script"

import { Header } from "@/components/Header"
import { Footer } from "@/components/Footer"
import { JsonLd, organizationJsonLd } from "@/lib/jsonld"
import { SITE_URL, SITE_NAME } from "@/lib/constants"

import "./globals.css"

export const metadata: Metadata = {
  title: {
    default: "AI Football Predictions & Match Forecasts | AI Predictor",
    template: "%s | AI Predictor",
  },

  description:
    "Explore AI-powered football predictions, win probabilities and predicted scores for the Premier League and major international competitions.",

  keywords: [
    "AI football predictions",
    "football match forecasts",
    "Premier League predictions",
    "World Cup predictions",
    "win probability",
  ],

  authors: [
    {
      name: "AI Predictor",
    },
  ],

  creator: "AI Predictor",

  metadataBase: new URL(SITE_URL),

  verification: {
    google: "REPLACE_WITH_YOUR_GSC_VERIFICATION_CODE",
  },

  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: SITE_NAME,
    title: "AI Football Predictions & Match Forecasts | AI Predictor",
    description:
      "Explore AI-powered football predictions, win probabilities and predicted scores for the Premier League and major international competitions.",
    images: [
      {
        url: "/og/ai-football-predictions.png",
        width: 1200,
        height: 630,
        alt: "AI Football Predictions & Match Analysis",
      },
    ],
  },

  twitter: {
    card: "summary_large_image",
    title: "AI Predictor",
    description:
      "AI-powered football predictions, match forecasts and data-driven analysis for major football competitions.",
  },

  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
    description:
      "AI-powered football predictions, match forecasts and data-driven analysis for major football competitions.",
    potentialAction: {
      "@type": "SearchAction",
      target: `${SITE_URL}/predictions?search={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  }

  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {/* Google Analytics */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-WHJD1T3GDX"
          strategy="afterInteractive"
        />

        <Script id="ga4-config" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];

            function gtag() {
              window.dataLayer.push(arguments);
            }

            gtag("js", new Date());
            gtag("config", "G-WHJD1T3GDX");
          `}
        </Script>

        {/* Organization structured data */}
        <JsonLd data={organizationJsonLd()} />

        {/* Website structured data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(websiteJsonLd),
          }}
        />
      </head>

      <body className="flex min-h-full flex-col">
        <Header />

        {/* Adsterra advertisement */}
        <div className="mx-auto w-full max-w-7xl px-4 py-4">
          <div id="container-bd622784d68115f3cb961983a0aa445c" />
        </div>

        <Script
          id="adsterra-native-ad"
          src="https://servicessitclaims.com/bd622784d68115f3cb961983a0aa445c/invoke.js"
          data-cfasync="false"
          strategy="afterInteractive"
        />

        <main className="flex-1">{children}</main>

        <Footer />
      </body>
    </html>
  )
}
