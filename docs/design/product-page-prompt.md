# The prompt

Paste into the Claude Design session. It has the repo, so this points rather than explains;
`docs/design/product-page-brief.md` is the brief it refers to.

---

A full rewrite of the landing page, into a product page. The brief is
**`docs/design/product-page-brief.md`**.

**Start with §2**, because it reverses one of your own rulings and I would rather you
argue with the reversal than execute it. `landing-page-brief.md` §5.5 asked how much page
there is below the hero and you answered, correctly, that there is none — brand §11 says
nothing needs to be written underneath the wipe. That answer described a product whose
whole surface was one page you wipe. Since then: nine pages with templates and per-page
history, a history pane with per-line restore, and the operator's own instructions
reaching every agent conversation. The live page describes 1.0. **If you still think a
one-screen site is right and everything below should live in the README instead, say so
plainly — that is a real answer and I want it stated rather than routed around.**

Assuming it is not, four things about what this page is now:

1. 🔴 **§7.1 is the ask I actually need, and the rest is downstream of it.** The one
   animated scene has a beat where lines arrive on the page and were not put there by the
   person watching. Chat bubble, robot, sparkle and purple gradient are all on the kill
   list and the first one is the entire category's cliché. The only asset the brand
   already owns here is the two voices — DM Mono is what the app says about itself.
   Whether it stretches to *what the agent did* is the same typographic question you
   flagged for the history pane, and this time it is load-bearing: this is the claim
   nobody else in the comparable set can make, and it is the reason there is a product
   page at all.

2. **One scene, not four.** §5 — the workout, five beats, because it is the only use case
   that carries every claim in one loop. The other three are a row of text. Three more
   animations turn the one expressive moment in the product into wallpaper, which is your
   own reasoning for why the hero does not loop.

3. **The hero is the one part with a prior ruling behind it, and §4.1 asks whether it
   survives.** I think the mechanics do — scroll-triggered, once, at the app's real
   260/14/130 — and the sub line does not. *"One page. Wiped every morning."* is the only
   line above the fold, it restates the headline, and it describes the product before
   pages and before the agent. That line is the highest-value real estate on the site.

4. **What the page asks for is `git clone`.** No signup, no waitlist, no hosted version,
   no price. A Worker and a D1 in your own account, MIT, and the data is yours in a way
   no comparable product's is. That is the CTA and I think it is also a claim.

Three constraints that a rewrite is exactly the moment for dropping, so they are restated
in §6 and I will hold you to them: **one static self-contained file, no CDN and no build
step** — `pages.yml` uploads `site/` as a folder and its own comment says a build step
means the constraint has been quietly abandoned; **slate only**, no second board; and
**700 is the heaviest weight that exists**, which the live hero already answers with 600
plus tracking and scale rather than a fourth font file.

🔴 **Two things I found writing the brief**, both in §10, both yours to overrule:

- **`worker/test/site.test.ts` asserts something that is no longer true.** The check
  `not.toMatch(/\byour pages\b/i)` was written in 0.16.0 to enforce spec §12's "no second
  document." Pages shipped in 1.1. The test now forbids the page from describing a
  feature the product has, and it has been green the whole time because nothing has tried
  to say it. My fix is to swap the pattern for what is *still* out — folders, search, due
  dates, tags, notebooks, second brain — but that is a scope call as much as a test edit.

- **The history claim has two halves and only one of them is a week.** The pane is seven
  days; `cleared_items` is never pruned and the API takes any range. So *"what did I lift
  in March"* is answerable by asking Claude and not by scrolling, and a page that says
  "full history" next to a seven-day pane has written its own bug report. §9 has the
  numbers; every number on the page has to come from that table.

Mobile-first, amber the only colour, and the same rule as always: the build applies the
number you give, not the one I wrote.
