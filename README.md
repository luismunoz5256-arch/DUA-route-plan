# DUA Route Planner

A website for planning the daily delivery routes. The employee picks today's stops and the number of drivers. The planner then splits the stops between drivers and orders each route so that:

- everyone is back at the warehouse (840 N Hawkins Blvd) by the "back by" time (default 4:00 PM, leaving at 11:30 AM),
- priority stops arrive by their "deliver by" time,
- total paid driver time (cost at $14/hr) is as low as possible,
- drivers finish at roughly the same time. You can make this stricter with the **Even finish times** setting.

It also compares one driver fewer and one driver more, and marks the cheapest plan that is still on time as **Best**.

Everything runs in the browser. There is no server and no monthly hosting cost. **Clients, settings and the Google key are saved only in the browser on the computer you use. They are never put on GitHub.**

---

## 1. Put the website online (GitHub Pages, free)

1. On GitHub, open the repository → **Settings** → **Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch with this code (`main` after merging, or `claude/delivery-route-optimizer-7javjd`), folder **/ (root)**, then **Save**.
3. After a minute the site is at `https://luismunoz5256-arch.github.io/DUA-route-plan/`. Bookmark it on the office computer.

On a free GitHub plan the repository has to be public for Pages to work. That's fine: only the program code is public. Your client list and API key never leave your browser, and the site asks search engines not to list it.

## 2. Get a Google Maps key (free if you stay under Google's monthly free amounts)

Google uses traffic data to give real drive times. Google asks for a card, but the planner is built to stay inside the free amounts:

- Drive times between your clients are looked up **once** (using typical traffic at 12:30 PM on a weekday) and **saved**. Planning a normal day then makes **no Google requests at all**. Adding a new client only looks up that client's times.
- The planner counts its own lookups and stops at the monthly limits in **Settings** (default 4,000 drive times and 2,000 address lookups). It asks before going over.

Google's free amounts change from time to time. Check the current numbers at <https://mapsplatform.google.com/pricing/>. Traffic-aware drive-time lookups are the "Compute Route Matrix" item.

Steps:

1. Go to <https://console.cloud.google.com/>, create a project (e.g. "Route Planner") and add a billing account.
2. **APIs & Services → Library**: enable **Routes API** and **Geocoding API**.
3. **APIs & Services → Credentials → Create credentials → API key**. Edit the key:
   - **API restrictions → Restrict key**: tick only *Routes API* and *Geocoding API*.
4. Recommended safety nets:
   - **Billing → Budgets & alerts**: create a $1 budget with email alerts, so you hear about it immediately if anything is ever charged.
   - **APIs & Services → Routes API → Quotas** (and the same for Geocoding API): lower the per-day limits. Google then refuses requests instead of billing past them.
5. In the planner open **Settings**, paste the key under **Google Maps → API key**, and click **Save settings**.

The planner also works without a key. It then uses straight-line distance estimates, which are rougher, and shows a warning on the results.

## 3. First-time setup in the planner

1. **Settings** → check the warehouse address → **Find** → **Save settings**. Also check the leave/back-by times, hourly pay ($14), default unload time and the default priority "deliver by" time.
2. **Clients** → add clients one at a time with **Add client**, or **Import CSV** from a spreadsheet. Columns:
   `name, address, days, unload, earliest, latest, notes`
   - `days`: e.g. `Mon Wed Fri`, `Mon-Sat` or `daily` (clients who order now and then can leave it blank)
   - `unload`: minutes at the stop (default 10)
   - `earliest` / `latest`: optional delivery hours, e.g. `13:00` or `1pm`
3. **Clients → Find missing locations** puts every client on the map.
4. Optional: **Settings → Pre-load drive times for all clients** looks up all drive times in one go. With 60 clients that's about 3,700 lookups, done once.
5. **Settings → Download backup** now and then (or to move to another computer).

## 4. Daily use

1. **Plan routes** → pick the date. Clients who usually order that weekday are already checked.
2. Check or uncheck stops to match today's orders. Tick **Priority** for urgent stops and set **Deliver by**. Add a note for today if needed.
3. Choose the number of drivers (and their names), then click **Build routes**.
4. In **Compare driver counts**, click a row to view that plan. The **Best** row is the cheapest one where everyone is back on time.
5. Give drivers their routes:
   - **Print route sheets**: one page per driver.
   - **Open in Google Maps**: turn-by-turn navigation. Google allows 9 stops per link, so long routes get Part 1 / Part 2.
   - **Copy for text**: the stop list with times and map links, ready to paste into a text message.

---

## How it works (technical)

- `index.html`, `css/`, `js/`: a static site, no build step. The map is [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles, kept in `vendor/`.
- `js/solver.js`: a vehicle-routing optimizer with time windows. It removes a few stops at a time and re-inserts them where they cost least ("ruin and recreate"), accepts some worse moves early on (simulated annealing), then does a 2-opt clean-up. It minimizes total paid minutes, with heavy penalties for late stops and returns past the back-by time, and a weight for uneven finish times. It runs in a Web Worker, taking about 2 seconds per driver count.
- `js/matrix.js` and `js/google.js`: Google Routes API `computeRouteMatrix` (`TRAFFIC_AWARE`) and Geocoding API, called from the browser and cached in `localStorage`.
- `js/store.js`: everything saved in `localStorage` under `dua.*` keys.

Run locally:

```sh
npm start        # serves http://localhost:8080
npm test         # optimizer tests (Node 18+)
```
