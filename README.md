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
- **English or Spanish:** click **Español** / **English** at the top of any screen, including the login screen and the driver's phone page. Each computer and phone remembers its own choice.
- **Logins with roles:** admin, secretary and driver. Everyone sees the same up-to-date data on any computer or phone, stored in a Google Sheet you own.

The website is free to host on GitHub Pages, and the Google Sheet is free too. **Your data never goes on GitHub.**

---

## 1. Put the website online (GitHub Pages, free)

1. On GitHub, open the repository → **Settings** → **Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch with this code (`main` after merging, or `claude/delivery-route-optimizer-7javjd`), folder **/ (root)**, then **Save**.
3. After a minute the site is live. Bookmark it, or add it to phones' home screens (below).

On a free GitHub plan the repository has to be public for Pages to work. That's fine: only the program code is public. Your clients, routes and API key live in your own Google Sheet behind logins, and the site asks search engines not to list it.

### A shorter link (free)

The web address comes from the repository's name. To change it, go to **Settings → General → Repository name**, type the new name, and click **Rename**:

| Repository name | Web address |
|---|---|
| `luismunoz5256-arch.github.io` | **`https://luismunoz5256-arch.github.io`** (the shortest possible) |
| `rutas` | `https://luismunoz5256-arch.github.io/rutas/` |
| `DUA-route-plan` (now) | `https://luismunoz5256-arch.github.io/DUA-route-plan/` |

Good to know:
- **No code changes needed.** Nothing in the app depends on the name.
- **People stay logged in.** Every option above is on the same `luismunoz5256-arch.github.io` site, so logins and saved data on each computer and phone carry over.
- **The old address stops working.** It isn't forwarded to the new one, so update bookmarks and home-screen icons, and send the new link to drivers. GitHub does forward the old name for code pushes.
- **After renaming, check Settings → Pages** to confirm the branch and folder are still selected.
- **Want your own address later (like `duaroutes.com`)?** Buy the name (about $10–15 a year), add it under **Settings → Pages → Custom domain**, and point the domain's DNS to GitHub as that page explains.

### Add it to phones' home screens

The site has a green truck icon and opens full-screen like an app.
- **iPhone (Safari):** open the site, tap **Share** (square with an arrow), then **Add to Home Screen**.
- **Android (Chrome):** open the site, tap **⋮**, then **Add to Home screen** or **Install app**.

Drivers should add it from the **login page**, not from a route link they were texted, so it always opens their latest route. On iPhone the home-screen app keeps its own login, so log in once more after adding it.

## 2. Get a Google Maps key (free if you stay under Google's monthly free amounts)

Google uses traffic data to give real drive times. Google asks for a card, but the planner is built to stay inside the free amounts:

- Drive times between your clients are looked up **once** (using typical traffic at 12:30 PM on a weekday, and again at 4:00 PM for driving later in the day) and **saved**. The afternoon times are used for any driving that starts after the halfway point (2:15 PM), so return times reflect the afternoon traffic. Each pair of places is looked up once for each time, so the first weeks use about twice as many lookups as before; leave **Afternoon traffic sample time** blank in Settings to switch it off. Planning a normal day then makes **no Google requests at all**. Adding a new client only looks up that client's times.
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
| **Secretary** | Clients, daily stops, build and send routes, hand edits, orders that come in after the routes went out, History. Can't change Settings or Users. |
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
- **Only Admin accounts see Users, Settings and Trucks.** The top-right corner shows who is logged in and their role (for example "boss · Admin").
- **Locked out of admin?** On the login page, click **Locked out of admin? Use the setup code**. Enter the `SETUP_CODE` from the script, a username (yours or a new one) and a new password. That account becomes an admin. Wrong codes lock this for 15 minutes after 5 tries.
- **Logging out** wipes the data saved in that browser. Everything stays in the Google Sheet.
- **Changing the script later:** update it in Apps Script, then **Deploy → Manage deployments → Edit → Version: New version → Deploy**. That keeps the same URL.
- **Google key:** the admin enters it once in Settings. It's shared with admin and secretary logins so they can build routes, but never sent to drivers.

## 4. First-time setup in the planner (as admin)

1. **Settings** → check the warehouse address → **Find** → **Save settings**. Also check clock-in (8:00), leave (11:30), latest return, hourly pay ($14), regular hours (8/day, 40/week), fuel cost per mile, default unload time and the default priority "deliver by" time.
2. **Clients** → add clients one at a time with **Add client**, or **Import CSV** from a spreadsheet. Columns:
   `name, address, days, unload, earliest, latest, notes`
   - `days`: e.g. `Mon Wed Fri`, `Mon-Sat` or `daily` (clients who order now and then can leave it blank)
   - `unload`: minutes at the stop (default 10)
   - `earliest` / `latest`: optional delivery hours, e.g. `13:00` or `1pm`. For different hours on certain days (e.g. only until 10:00 on Mondays), open the client and use **Different delivery times on some days**; a blank time there means the usual one
3. **Clients → Find missing locations** puts every client on the map.
4. Optional: **Settings → Pre-load drive times for all clients** looks up all drive times in one go. With 60 clients that's about 3,700 lookups, done once.
5. Optional: **Settings → Download backup** for an extra copy (everything is already in the Google Sheet).

## 4b. Connect MyGeotab truck tracking (optional, admin only)

This adds a **Trucks** tab, visible to admins only. It shows:
- **Live map:** each truck's position, whether it's driving or stopped, and for how long.
- **Planned vs. actual:** for every stop, when the truck actually arrived, how long it stayed, and whether it was on time, late or never reached.
- **Day report per driver:** when they left and got back, driving time, idle time and miles. Stops that weren't on the route are listed with how long the truck sat there.
- **Every truck, any day:** pick a date to see each truck's report for that day, like MyGeotab's per-truck view. Trucks without an assigned driver show up under their own name.
- **Weekly payroll from the trucks:** in **History**, pick a week and click **Get this week's return times from the trucks**. The app fills in every day's real return time (marked 🚚) and works out hours, overtime and pay, even for days nobody built a plan in the app. **Download payroll (CSV)** gives a spreadsheet for the week. If a time is wrong, type the right one in the day's **Back** box. A typed time always wins over the truck's time.

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

**Real stop times.** Every time the planner reads a truck's day, it records how long the truck stayed at each client on its route. When an admin opens the planner, it also reads any of the past week's days it hasn't read yet, so this (and the real return times for payroll) happens by itself. Once a client has 3 visits, planning uses the typical stay (the middle value, so one long lunch stop doesn't throw it off) instead of the typed unload time. Stops shorter than 1 minute or longer than 90 aren't counted, and only the last 20 visits are kept. The stop list and Clients list mark these times with 🚚, and the client form says how many visits they come from. Switch it off in **Settings → Truck tracking → Plan with real stop times from the trucks**.

## 4c. Connect QuickBooks Desktop (optional, admin)

When the secretary saves an invoice in QuickBooks, its client is checked in the planner for the invoice's date. If routes are already out, the stop goes onto a truck right away and shows as **New** on that driver's phone. A voided or deleted invoice takes the stop off again. When orders close, all that's left is **Set final driving order** (or **Build routes**) and **Print route sheets**.

How it works: QuickBooks Desktop has no online connection, so a small helper runs on the office PC where QuickBooks is open. Every minute it reads the invoices dated today through the next 6 days and sends them to the planner. It only reads invoices; it never changes anything in QuickBooks.

- **Matching clients:** an invoice goes to the client with the same **QuickBooks customer name** (field in the client form), or the same name. A customer the planner doesn't know yet is added automatically from the invoice's ship-to address (bill-to if there's no ship-to) and found on the map. If the names differ (e.g. "Cafe Central Inc" in QuickBooks, "Café Central" in the planner), the planner adds a copy. The **Clients** tab then lists **Possible duplicates** (same address, same spot on the map or a similar name) with a **Merge** button: it moves the QuickBooks link, the day's orders and route stops onto your client and removes the copy, so future invoices go straight to your client. **Not the same** hides a wrong suggestion. For a duplicate it didn't spot, open the copy (**Edit**) and use **Merge this one into** at the bottom of the form.
- **Regulars:** clients who usually order that day are still checked in the morning, so drivers can load early. The Stops list shows which checked stops have an invoice (🧾) and which don't, with **Uncheck them** for the ones that never ordered.
- If you uncheck an invoiced stop by hand, it stays unchecked.

**A. Update the Google Sheet script** (once, because the script gained the QuickBooks connection): open your Sheet → **Extensions → Apps Script**, replace everything with the new [`apps-script/Code.gs`](apps-script/Code.gs) (keep your `SETUP_CODE` line), **Save**, then **Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy**.

**B. Get the two files.** In the planner, log in as admin and open **Settings → QuickBooks Desktop**:
1. **Download the helper** → `qb-sync.ps1`.
2. **Download its settings file** → `qb-settings.json`. It holds your server address and a key that lets the helper send invoices (and nothing else). Making a new key stops the old one.

**C. Set it up on the office PC** where the secretary has QuickBooks open (in multi-user mode that's her PC; QuickBooks has to be open and logged in during order hours):
1. Make a folder, e.g. `C:\DUA-QuickBooks`, and put both files in it.
2. Open QuickBooks with the company file, logged in as **Admin**. Check **Edit → Preferences → Integrated Applications → Company Preferences**: "Don't allow any applications to access this company file" must be **off**.
3. Open **PowerShell** (Start menu → type PowerShell), then run:
   ```
   cd C:\DUA-QuickBooks
   powershell -ExecutionPolicy Bypass -File .\qb-sync.ps1 -Test
   ```
4. QuickBooks asks whether to let **DUA Route Planner** access the company file. Choose **"Yes, always"** and **Continue**. (If QuickBooks says this needs single-user mode, switch with **File → Switch to Single-user Mode**, run the test again, then switch back to multi-user.)
5. The test lists the invoices it found (date, number, customer, address) and sends nothing. Check that the addresses look right.
6. Install it so it runs in the background now and every time Windows starts:
   ```
   powershell -ExecutionPolicy Bypass -File .\qb-sync.ps1 -Install
   ```
7. Within a minute, **Settings → QuickBooks Desktop** in the planner says when the helper last sent invoices. The Stops list warns if it hasn't heard from the helper for 10 minutes (usually because QuickBooks was closed).

To stop it: `powershell -ExecutionPolicy Bypass -File .\qb-sync.ps1 -Uninstall`. Everything it does is written to `qb-sync.log` in the same folder.

If the test says **QBXMLRP2 is missing**, the QuickBooks connector isn't installed on that PC. Install the free **QuickBooks Desktop SDK** from Intuit's developer site (developer.intuit.com → QuickBooks Desktop → SDK), then try again.

## 5. Daily use

1. **Plan routes** → pick the date. Clients who usually order that weekday are already checked.
2. Check or uncheck stops to match today's orders. Tick **Priority** for urgent stops and set **Deliver by**. Add a note for today if needed.
3. Choose the number of drivers. Check their names and **hours worked this week** (filled in from History; type over it if it's wrong). Click **Build routes**.
4. In **Compare driver counts**, see labor (with overtime), fuel and total for one driver fewer, the number you asked for, and one more. You see the plan for the number of drivers you picked. The cheapest workable plan is marked **Best**; click its row (or **Show that plan**) to switch to it.
5. Adjust if needed: ▲ ▼ reorders a stop, **Move to…** gives it to another driver (and keeps it with them if you build again).

**Route shape.** **Keep drivers in their own area** (next to Even finish times) makes the planner prefer plans where each driver stays in one part of town when the cost is about the same: *Some* (the default) costs very little, *Strong* a bit more, *Off* is the cheapest possible. With a Google key, the map draws the real roads each truck takes (asked once per route and saved in that browser, counted under a monthly limit of 1,500) instead of straight lines, which can look like zig-zags when a truck uses the highway. The stop list flags clients whose map spot looks wrong (⚠ check location: more than 40 km away, dropped in the middle of El Paso because the street wasn't found, or at the same spot as a different address), since one misplaced client can pull a driver across town. Under the comparison, the planner names deliver-by times that can't be met even as a driver's first stop.

**Deciding who takes what.** The stop list has a **Driver** column. Leave it on **Auto** to let the planner choose, or pick a driver for any stop (**Fill in usual drivers** fills every empty one with the client's usual driver). **Build routes** then keeps those stops with their driver and finds the best order for each route; stops left on Auto go wherever is cheapest. The results also say what your choices cost compared with letting the planner choose every driver. Changing a stop's driver after routes are out moves it to that truck right away. For a standing rule, open the client, pick their **Usual driver** and tick **Always this driver** (📌 in the Clients list).
6. Send each driver their **phone link** (**Copy phone link** or **Copy for text**), or **Print route sheets**.
7. Orders keep coming in after the routes went out? Just check the stop (see below).
8. At the end of the day, if someone came back much later or earlier than planned, fix their **Back** time in **History** so the week's hours and overtime stay right.

### Loading while orders come in

Drivers load their trucks in the morning, but orders come in until 10:00. So the plan is built in steps instead of all at 10:00:

1. **First thing in the morning, build the routes** with the regular clients. Each client stays with their **usual driver** unless giving them to someone else saves more than the amount in Settings ($10 by default). A client's usual driver is set on the client (**Usual driver**), or learned from the last 30 days of routes. Drivers know most of their stops at 8:00 and can start loading.
2. **As orders come in, check the stop.** It goes straight onto a truck (the cheapest spot, preferring the client's usual driver) and shows as **New** on that driver's phone. Unchecking a stop takes it off, and the driver's phone lists it under "do not deliver". Nobody else's stops move. Any office computer can do this; they all share the same plan.
3. **When orders close** (Settings → Orders close at, 10:00 by default), click **Set final driving order**. No stop moves to another truck; each driver gets the best driving order and arrival times, and their phone says the order is final. If moving a few stops between trucks would save more than the Settings amount, the app lists them and you choose **Move them** (only if those orders aren't loaded yet) or **Keep as is**.

**Clearing and rebuilding.** **Clear** (unchecking every stop) takes the day's routes down; checking stops again then just picks them, and **Build routes** plans the day from scratch. When routes are already out, **Build routes** keeps stops on the truck they're on (drivers may have loaded them), and also plans the day from scratch: if that would be cheaper, it says how much and how many stops would change trucks, with **Use the plan from scratch**.

**What usual drivers are learned from.** Every time routes are built (and again at **Set final driving order**, with the whole day's orders), the planner also works out its own best plan for the day, ignoring drivers picked by hand and which truck stops are already on. Usual drivers are learned from that plan, not from the routes you actually send. So on days drivers already loaded their own routes, edit the routes to match them: the phones, real stop times and payroll follow what was sent, and the learning still follows the best plan.

**Learning period.** If the routes you have now aren't the best ones, don't let the app copy them: in **Settings → Orders & usual drivers**, set **Learn usual drivers until** a date (it starts set to Saturday, October 31, 2026, two weeks of learning). Until then, routes ignore usual drivers and are planned the cheapest way each day, and each area keeps the same driver from day to day (the app gives each route to the driver who had most of those stops before). After that date, each client stays with the driver they had most often during the learning period. Usual drivers typed on a client are also ignored until then.

Driver phones check for changes every minute while the app is open (and right away when it's reopened). Office computers check every 2 minutes.

---

## How it works (technical)

- `index.html`, `css/`, `js/`: a static site, no build step. The map is [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles, kept in `vendor/`.
- `js/solver.js`: a vehicle-routing optimizer with time windows. It removes a few stops at a time and re-inserts them where they cost least ("ruin and recreate"), accepts some worse moves early on (simulated annealing), then does a 2-opt clean-up. It minimizes pay (from clock-in, with per-driver overtime start) plus fuel, with heavy penalties for late stops and returns past the latest-return time, and a weight for uneven finish times. Each stop can have a usual driver (a cost per stop given to someone else) or be locked to a truck (for the final driving order). It runs in a Web Worker, taking about 2 seconds per driver count.
- `js/pay.js`: overtime rules and weekly hour totals.
- `driver.html` and `js/driver.js`: the driver phone page. The route is packed into the link after `#`, so it never touches a server.
- `apps-script/Code.gs`: the server. It handles logins (salted SHA-256, 30-day sessions, lockout after repeated failures), role checks, shared data and drivers' done ticks. `test/fake-apps-script.cjs` runs it in Node for the tests.
- `js/tracking.js`: turns Geotab trips (each one ends where the truck stopped) into left and back times, visits matched to planned stops, and unplanned stops. The server calls MyGeotab's JSON-RPC API (`Authenticate`, `Get` Device / DeviceStatusInfo / Trip / LogRecord) and caches the session.
- `js/i18n.js` and `js/es.js`: English/Spanish. The English text is the key and `es.js` holds the Spanish; `test/i18n.test.js` fails if any on-screen text is missing a translation.
- `js/api.js`, `js/sync.js` and `js/merge.js`: login calls and keeping the browser in step with the Sheet. Records merge by last edit, and deletes carry over.
- `js/matrix.js` and `js/google.js`: Google Routes API `computeRouteMatrix` (`TRAFFIC_AWARE`) and Geocoding API, called from the browser and cached in `localStorage`.
- `js/store.js`: everything saved in `localStorage` under `dua.*` keys.
- `tools/stamp.mjs`: gives every script and stylesheet a version tag (hash of its contents) in `index.html` and `driver.html`, through an import map for the modules. Browsers then load a file again exactly when it changed, so an update never mixes old and new files. **Run `npm run stamp` after changing anything in `js/` or `css/`**; the tests fail if you forget. A planner left open shows "A new version of the app is ready" with a **Reload** button after an update.
- `quickbooks/qb-sync.ps1`: the QuickBooks Desktop helper (Windows PowerShell 5.1). It asks QuickBooks for invoices with qbXML (`InvoiceQueryRq` by date, through the `QBXMLRP2.RequestProcessor` COM object) and posts them to the server's `qbPush` action. The server replaces each sent day as a whole, so deleted invoices drop off.

Run locally:

```sh
npm start        # serves http://localhost:8080
npm test         # optimizer, pay, sync-merge, tracking, server/login/Geotab and translation tests (Node 20+)
```
