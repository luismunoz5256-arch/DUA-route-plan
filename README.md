# DUA Route Planner

A website for planning the daily delivery routes. The employee picks today's stops and the number of drivers. The planner then splits the stops between drivers and orders each route at the **lowest total cost**:

- **Labor:** drivers are paid from clock-in (8:00 AM, when they make orders and load trucks) until they're back at the warehouse (840 N Hawkins Blvd), at $14/hr. Overtime is 1.5×: time past 8 hours in a day, or past 40 hours for the week. Texas follows the federal 40-hour rule. Hours already worked this week come from the History tab.
- **Fuel:** miles × fuel cost per mile.
- **Priority stops** arrive by their "deliver by" time, and nobody comes back after the **latest return** time (default 5:00 PM).
- Every extra driver costs their morning hours, so a little overtime is sometimes cheaper than another driver. The planner compares **one driver fewer, the number asked for, and one more**, and marks the cheapest workable plan as **Best**.

Also included:

- **Driver phone page:** each driver gets a link with their stops, a **Navigate** button per stop, and a **Done** tick.
- **Hand edits:** move stops up or down, or give a stop to another driver. Times and cost update instantly, and **Undo my changes** restores the original plan.
- **Late orders:** add a stop to routes that are already sent without reshuffling everyone.
- **History:** every day's routes, weekly hours per driver, overtime and estimated pay. You can correct a driver's actual return time.
- **Truck tracking (MyGeotab, optional):** a live truck map, planned vs. actual for every stop, a day report (left, back, driving, idling, unplanned stops) and real return times for payroll. Admin only.
- **Logins with roles:** admin, secretary and driver. Everyone sees the same up-to-date data on any computer or phone, stored in a Google Sheet you own.

The website is free to host on GitHub Pages, and the Google Sheet is free too. **Your data never goes on GitHub.**

---

## 1. Put the website online (GitHub Pages, free)

1. On GitHub, open the repository → **Settings** → **Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch with this code (`main` after merging, or `claude/delivery-route-optimizer-7javjd`), folder **/ (root)**, then **Save**.
3. After a minute the site is at `https://luismunoz5256-arch.github.io/DUA-route-plan/`. Bookmark it on the office computer.

On a free GitHub plan the repository has to be public for Pages to work. That's fine: only the program code is public. Your clients, routes and API key live in your own Google Sheet behind logins, and the site asks search engines not to list it.

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
5. After logins are set up (step 3), log in as admin, open **Settings**, paste the key under **Google Maps → API key**, and click **Save settings**.

The planner also works without a key. It then uses straight-line distance estimates, which are rougher, and shows a warning on the results.

## 3. Set up logins

Logins and all shared data live in a Google Sheet you own. It runs a small script that checks passwords and decides who may see what.

| Role | Can do |
|---|---|
| **Admin** | Everything: clients, daily stops, routes, history, **Settings** (pay, warehouse, Google key) and **Users** (add or remove people, reset passwords) |
| **Secretary** | Clients, daily stops, build and send routes, hand edits, late orders, History. Can't change Settings or Users. |
| **Driver** | Logs in on a phone and sees **only their own route**, with Navigate and Done. Done ticks show up in the office as "✓ Done 1:42 PM". |

One-time setup (about 10 minutes):

1. Create a new Google Sheet (name it e.g. "Route Planner data").
2. In the Sheet: **Extensions → Apps Script**. Delete what's there and paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs).
3. On the line `const SETUP_CODE = '...'`, change the setup code to something only you know. Click **Save**.
4. **Deploy → New deployment**. Click the gear → **Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then **Deploy**. Approve the permissions (it only touches this one Sheet).
5. Copy the **Web app URL** (it ends in `/exec`).
6. Open the planner website. Paste the URL as the **Server address**. It switches to **Create admin account**. Enter the setup code, then pick your admin username and password.
7. In **Users**, add each person with a role and a starting password. For drivers, also pick their **driver name** (the same name used on the Plan screen).
8. Each person opens the website and logs in. The first time on each computer or phone, they paste the server address. To skip that step, send me the URL and I'll put it in `js/config.js`.

Good to know:
- **"Anyone" access** in step 4 only means the website can reach the script. Every request still needs a valid login. After 5 wrong passwords, that username is locked for 15 minutes.
- **Passwords** are stored scrambled (salted hashes), never in plain text.
- **Logging out** wipes the data saved in that browser. Everything stays in the Google Sheet.
- **Changing the script later:** update it in Apps Script, then **Deploy → Manage deployments → Edit → Version: New version → Deploy**. That keeps the same URL.
- **Google key:** the admin enters it once in Settings. It's shared with admin and secretary logins so they can build routes, but never sent to drivers.

## 4. First-time setup in the planner (as admin)

1. **Settings** → check the warehouse address → **Find** → **Save settings**. Also check clock-in (8:00), leave (11:30), latest return, hourly pay ($14), regular hours (8/day, 40/week), fuel cost per mile, default unload time and the default priority "deliver by" time.
2. **Clients** → add clients one at a time with **Add client**, or **Import CSV** from a spreadsheet. Columns:
   `name, address, days, unload, earliest, latest, notes`
   - `days`: e.g. `Mon Wed Fri`, `Mon-Sat` or `daily` (clients who order now and then can leave it blank)
   - `unload`: minutes at the stop (default 10)
   - `earliest` / `latest`: optional delivery hours, e.g. `13:00` or `1pm`
3. **Clients → Find missing locations** puts every client on the map.
4. Optional: **Settings → Pre-load drive times for all clients** looks up all drive times in one go. With 60 clients that's about 3,700 lookups, done once.
5. Optional: **Settings → Download backup** for an extra copy (everything is already in the Google Sheet).

## 4b. Connect MyGeotab truck tracking (optional, admin only)

This adds a **Trucks** tab, visible to admins only. It shows:
- **Live map:** each truck's position, whether it's driving or stopped, and for how long.
- **Planned vs. actual:** for every stop, when the truck actually arrived, how long it stayed, and whether it was on time, late or never reached.
- **Day report per driver:** when they left and got back, driving time, idle time and miles. Stops that weren't on the route are listed with how long the truck sat there.
- **Real hours:** each truck's actual return time goes into **History** automatically, so weekly hours and overtime use real times. A time someone types in History always wins over the truck's time.

The Geotab login is stored only on your Google Sheet server. It's never sent to any browser, and secretaries and drivers can't reach the Geotab data at all.

**A. Create a separate Geotab login for the app.** Whoever manages your Geotab account can do this:
1. Log in to MyGeotab as an administrator.
2. Go to **People → Users & Drivers → + User**. The menu names can differ slightly between MyGeotab versions.
3. Fill in:
   - **Username / email:** e.g. `routeplanner@yourcompany.com`. It doesn't need to be a real mailbox, but some setups require one.
   - **Password:** something long.
   - **Security clearance:** **View only**, so the app can read data but never change anything.
   - **Data access:** the group your box trucks are in (usually the whole company).
   - Make sure **"This user is a driver"** is **off**.
4. Save. Then log in to MyGeotab once as this new user, in a private browser window. Geotab sometimes requires a password change on first login. Use the final password in the app.
5. Note your **database name**. It's the company name in the MyGeotab web address, e.g. `my.geotab.com/`**`dua_produce`**`/…`.

**B. Update the Google Sheet script.** This is needed once, because the script gained the Geotab connection:
1. Open your Sheet → **Extensions → Apps Script**. Replace everything with the new [`apps-script/Code.gs`](apps-script/Code.gs). Before you do, copy your current `SETUP_CODE` line and keep it in the new script.
2. Click **Save**. In the function menu at the top, pick **doGet** and click **Run**. Google asks for a new permission, "Connect to an external service", which is how the script talks to Geotab. Approve it.
3. **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy.** The web address stays the same.

**C. Connect in the planner.** Log in as admin and go to **Settings → Truck tracking (MyGeotab)**:
1. Enter the server (`my.geotab.com`), database, username and password, then click **Connect**.
2. Under **Which truck does each driver drive?**, pick each driver's truck.
3. Open the **Trucks** tab.

A stop counts as reached when the truck stops within 200 meters of the client's address. You can change that distance in Settings.

## 5. Daily use

1. **Plan routes** → pick the date. Clients who usually order that weekday are already checked.
2. Check or uncheck stops to match today's orders. Tick **Priority** for urgent stops and set **Deliver by**. Add a note for today if needed.
3. Choose the number of drivers. Check their names and **hours worked this week** (filled in from History; type over it if it's wrong). Click **Build routes**.
4. In **Compare driver counts**, see labor (with overtime), fuel and total for one driver fewer, the number you asked for, and one more. The cheapest workable plan is marked **Best** and shown. Click another row to view it instead.
5. Adjust if needed: ▲ ▼ reorders a stop, **Move to…** gives it to another driver.
6. Send each driver their **phone link** (**Copy phone link** or **Copy for text**), or **Print route sheets**.
7. A late order comes in? Use **Add a late order**.
8. At the end of the day, if someone came back much later or earlier than planned, fix their **Back** time in **History** so the week's hours and overtime stay right.

---

## How it works (technical)

- `index.html`, `css/`, `js/`: a static site, no build step. The map is [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles, kept in `vendor/`.
- `js/solver.js`: a vehicle-routing optimizer with time windows. It removes a few stops at a time and re-inserts them where they cost least ("ruin and recreate"), accepts some worse moves early on (simulated annealing), then does a 2-opt clean-up. It minimizes pay (from clock-in, with per-driver overtime start) plus fuel, with heavy penalties for late stops and returns past the latest-return time, and a weight for uneven finish times. It runs in a Web Worker, taking about 2 seconds per driver count.
- `js/pay.js`: overtime rules and weekly hour totals.
- `driver.html` and `js/driver.js`: the driver phone page. The route is packed into the link after `#`, so it never touches a server.
- `apps-script/Code.gs`: the server. It handles logins (salted SHA-256, 30-day sessions, lockout after repeated failures), role checks, shared data and drivers' done ticks. `test/fake-apps-script.cjs` runs it in Node for the tests.
- `js/tracking.js`: turns Geotab trips (each one ends where the truck stopped) into left and back times, visits matched to planned stops, and unplanned stops. The server calls MyGeotab's JSON-RPC API (`Authenticate`, `Get` Device / DeviceStatusInfo / Trip / LogRecord) and caches the session.
- `js/api.js`, `js/sync.js` and `js/merge.js`: login calls and keeping the browser in step with the Sheet. Records merge by last edit, and deletes carry over.
- `js/matrix.js` and `js/google.js`: Google Routes API `computeRouteMatrix` (`TRAFFIC_AWARE`) and Geocoding API, called from the browser and cached in `localStorage`.
- `js/store.js`: everything saved in `localStorage` under `dua.*` keys.

Run locally:

```sh
npm start        # serves http://localhost:8080
npm test         # optimizer, pay, sync-merge, tracking and server/login/Geotab tests (Node 18+)
```
