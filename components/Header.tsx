"use client"

import Link from "next/link"
import { Trophy, Menu, X, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import React from "react"

const mainLinks = [
  { href: "/", label: "Home" },
  { href: "/premier-league", label: "Premier League" },
  { href: "/football-predictions-today", label: "Predictions Today" },
  { href: "/premier-league/matches", label: "Fixtures & Results" },
  { href: "/prediction-accuracy", label: "Accuracy" },
  { href: "/world-cup/2026", label: "World Cup 2026 Archive" },
]

const moreLinks = [
  { href: "/simulator", label: "Match Simulator" },
  { href: "/ai-track-record", label: "World Cup Track Record" },
  { href: "/clubs", label: "Clubs" },
  { href: "/teams", label: "Teams" },
  { href: "/how-we-predict", label: "How We Predict" },
  { href: "/data-sources", label: "Data Sources" },
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact" },
]

export function Header() {
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [moreOpen, setMoreOpen] = React.useState(false)
  const moreRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!moreOpen) return
    function handlePointerDown(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false)
    }
    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [moreOpen])

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/60">
      <div className="container mx-auto flex h-16 items-center justify-between gap-2 px-4 max-w-7xl">
        <Link href="/" className="flex items-center gap-2" onClick={() => setMobileOpen(false)}>
          <Trophy className="h-6 w-6 text-sports-green" />
          <span className="flex flex-col leading-tight">
            <span className="font-bold text-lg text-sports-green">AI Predictor</span>
            <span className="hidden sm:block text-[10px] text-muted-foreground">AI-Powered Football Predictions</span>
          </span>
        </Link>

        {/* Desktop Nav */}
        <nav className="hidden lg:flex items-center gap-1" aria-label="Primary">
          {mainLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              <Button variant="ghost" size="sm" className="text-sm font-medium">
                {link.label}
              </Button>
            </Link>
          ))}

          {/* More dropdown */}
          <div className="relative" ref={moreRef}>
            <Button
              variant="ghost"
              size="sm"
              className="text-sm font-medium"
              aria-haspopup="true"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              More <ChevronDown className={cn("ml-1 h-3.5 w-3.5 transition-transform", moreOpen && "rotate-180")} />
            </Button>
            {moreOpen && (
              <div className="absolute right-0 top-full z-50 mt-2 w-60 rounded-lg border bg-white p-1 shadow-lg">
                {moreLinks.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => setMoreOpen(false)}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </nav>

        {/* Mobile toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </div>

      {/* Mobile Nav */}
      {mobileOpen && (
        <nav
          id="mobile-nav"
          aria-label="Mobile"
          className="lg:hidden max-h-[calc(100vh-4rem)] overflow-y-auto border-t bg-white px-4 pb-4 pt-2"
        >
          {mainLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="block py-2.5 text-sm font-medium text-foreground transition-colors hover:text-sports-green"
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <div className="mt-2 mb-1 border-t pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            More
          </div>
          {moreLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="block py-2.5 text-sm font-medium text-foreground transition-colors hover:text-sports-green"
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  )
}
