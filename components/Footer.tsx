import Link from "next/link"
import { Trophy } from "lucide-react"
import { teamCrestNote } from "@/lib/football/team-crests"

export function Footer() {
  return (
    <footer className="border-t bg-muted/50 mt-auto">
      <div className="container mx-auto max-w-7xl px-4 py-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-2 font-bold text-lg text-sports-green mb-3">
              <Trophy className="h-5 w-5" />
              AI Predictor
            </Link>
            <p className="text-sm text-muted-foreground">
              AI-powered football predictions, match forecasts and data-driven analysis for major football competitions.
            </p>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Predictions</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/champions-league" className="hover:text-sports-green transition-colors">Champions League</Link></li>
              <li><Link href="/premier-league" className="hover:text-sports-green transition-colors">Premier League</Link></li>
              <li><Link href="/predictions" className="hover:text-sports-green transition-colors">World Cup Predictions</Link></li>
              <li><Link href="/winner-predictions" className="hover:text-sports-green transition-colors">Winner Odds</Link></li>
              <li><Link href="/simulator" className="hover:text-sports-green transition-colors">Match Simulator</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Teams</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/teams" className="hover:text-sports-green transition-colors">All Teams</Link></li>
              <li><Link href="/team/argentina" className="hover:text-sports-green transition-colors">Argentina</Link></li>
              <li><Link href="/team/brazil" className="hover:text-sports-green transition-colors">Brazil</Link></li>
              <li><Link href="/team/france" className="hover:text-sports-green transition-colors">France</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Info</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/world-cup/2026" className="hover:text-sports-green transition-colors">World Cup 2026 Archive</Link></li>
              <li><Link href="/about" className="hover:text-sports-green transition-colors">About Us</Link></li>
              <li><Link href="/how-we-predict" className="hover:text-sports-green transition-colors">How We Predict</Link></li>
              <li><Link href="/data-sources" className="hover:text-sports-green transition-colors">Data Sources</Link></li>
              <li><Link href="/contact" className="hover:text-sports-green transition-colors">Contact</Link></li>
            </ul>
          </div>
        </div>

        <div className="border-t mt-8 pt-6 text-center text-xs text-muted-foreground">
          <p>&copy; {new Date().getFullYear()} AI Predictor. Independent football analysis platform. Not affiliated with FIFA, UEFA, the Premier League, or any football governing body. Predictions are for informational and entertainment purposes only. <Link href="/how-we-predict" className="underline hover:text-sports-green">How our predictions work</Link>.</p>
          <p className="mt-2">{teamCrestNote}</p>
        </div>
      </div>
    </footer>
  )
}
