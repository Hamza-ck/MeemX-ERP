# MEEMX ERP — Complete Accounting & Tally Solutions

Modern accounting and business management PWA designed with an executive dashboard, Supabase account sign-in with an optional device PIN lock, material-wise inventory, debtors & creditors ledger tracking with WhatsApp reminders, loans & advances, and Tally file import.

## ✨ Features

- **Executive & Admin Dashboards**:
  - Daily & monthly sales, gross & net profit, operating expenses, and live KPIs.
  - Interactive 7-day revenue trend bar chart.
  - Custom drag-and-drop layout ordering & card visibility control for the Owner.
- **Account Authentication & Device Lock**:
  - Supabase email/password sign-in; application roles come from the authenticated profile.
  - Optional 4-digit local PIN lock for the current device after account sign-in.
  - Local PINs do not grant or change account roles.
- **Debtors & Creditors**:
  - 3-segment aging breakdown (`0–30d`, `31–60d`, `60d+`).
  - One-click **Call** & **WhatsApp payment reminder** with pre-filled message templates.
  - Permanent UID circulation for debtors with outstanding closing dues.
- **Inventory Management**:
  - Material-wise stock tracking with health indicators (`Low`, `Healthy`, `Out of stock`).
  - Filtering by `All`, `Low stock`, and `Slow moving`.
- **Tally Data Import**:
  - Full support for Tally Prime and Tally ERP 9 XML & Excel Day Book, ledgers, and masters.
  - Pre-import validation engine with automated discrepancy resolution.
- **Offline-First Resilience**:
  - Fully functional client-side persistence powered by Dexie IndexedDB.
  - PWA support with service worker precaching.

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ or 20+ or 22+
- npm or bun

### Installation

```bash
# Clone the repository
git clone https://github.com/Hamza-ck/Inventory-App.git
cd Inventory-App

# Install dependencies
npm install

# Configure the browser app with your Supabase project URL and public anon key
# VITE_SUPABASE_URL=https://<your-project>.supabase.co
# VITE_SUPABASE_ANON_KEY=<your-anon-key>

# Start development server
npm run dev
```

Create Supabase Auth accounts and matching `profiles` records with an assigned role (`admin`, `owner`, or `employee`) before signing in. Apply `supabase/schema.sql` and configure the required Edge Function secrets for imports and account creation.

The app will be available at `http://localhost:3000`.

### Local data and cloud sync

- Accounting changes are saved in the current browser's IndexedDB first, so the app can keep working without a connection. Changed rows remain marked for sync until an administrator account uploads them successfully.
- Signed-in users can read the cloud snapshot. Only an account whose Supabase `profiles.role` is `admin` can upload changes or process deletion requests; database row-level security enforces this rule.
- A failed cloud read leaves the current local records untouched. Deletes are queued locally and become cloud tombstones (`deleted_at`) during an administrator sync, so another device can converge without treating an incomplete page of results as a deletion.
- When an administrator uploads a dirty row, its local values take precedence over the cloud copy. There is no conflict-resolution screen; the last successful administrator upload wins. Review edits on other devices before syncing if concurrent work is possible.
- A device PIN is an optional local screen lock after account sign-in. It does not authenticate an account or grant an application role. Without a configured PIN, successful account sign-in opens the app directly.
- Use **Export all data** before device replacement or recovery. Cloud sync is not a backup service, and browser-local data is not available on a new device until it has been synced.

Apply the ordered SQL files under `supabase/migrations/` to an existing project. For a fresh project, use `supabase/schema.sql` and deploy the required Edge Functions.

### Building for Production

```bash
npm run build
```

Production assets are emitted to `dist/` ready to be served by any static host (Vercel, Netlify, Cloudflare Pages, Firebase Hosting, Nginx).

## 🔌 Tally Connector

A lightweight, read-only Node.js tool that runs on the shop PC next to TallyPrime, extracts master data and vouchers over Tally's local HTTP interface, and securely pushes them to MeemX ERP via the Supabase `tally-import` edge function.

### 1. Enabling Tally's HTTP Server
Before running the connector, enable Tally's local XML/HTTP server:
- **TallyPrime**: Press `F1` (Help) > **Settings** > **Connectivity** > Set **Client/Server configuration** to *Both* or *Server*, and set **Port** to `9000`.
- **Tally.ERP 9**: Press `F12` (Configure) > **Advanced Configurations** > Set **Tally is acting as** to *Server*, and **Port** to `9000`.
- Refer to [Tally Solutions Official XML Integration Guide](https://help.tallysolutions.com/) for detailed version-specific instructions.

### 2. Configuration
Create a `connector/.env` file (git-ignored) or set environment variables:
```env
TALLY_HOST=[IP_ADDRESS]  # Tally Machine IP address 
TALLY_PORT=9000
TALLY_COMPANY="Your Company Name Exactly As In Tally"

SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_EMAIL=admin@yourcompany.com
SUPABASE_PASSWORD=<admin-password>
```

### 3. Usage & Commands
Run commands from the repository root:

- **Discover (Safe Test)**: Queries Tally for masters and recent vouchers and saves raw XML into `connector/samples/` for verification. Does **not** modify or push to the database:
  ```bash
  node connector/sync.mjs discover
  # Or with specific date range:
  node connector/sync.mjs discover --from 2026-10-01 --to 2026-10-15
  ```

- **Full Pull**: Pulls masters and vouchers across a date range in monthly chunks:
  ```bash
  node connector/sync.mjs pull --from 2026-01-01 --to 2026-10-26
  ```

- **Incremental Sync**: Syncs recent entries with a 7-day safety overlap to catch edited vouchers:
  ```bash
  node connector/sync.mjs incremental
  # First-run window option (default 30 days) and sequential chunk size (default 15 days):
  node connector/sync.mjs incremental --max-days 30 --chunk-days 10
  ```

- **Continuous Background Loop**: Automatically synchronizes every N minutes (default 15 minutes) until stopped:
  ```bash
  node connector/sync.mjs incremental --loop --every 15
  ```

### 4. Windows Task Scheduler Setup (5 Steps)
To automatically run the connector unattended on the shop PC:
1. Open **Task Scheduler** on Windows (`taskschd.msc`).
2. Click **Create Basic Task...** and name it `MeemX Tally Sync`.
3. Choose trigger: **Daily**, recur every `1` day, and set repeating every `15 minutes` under advanced trigger properties.
4. Select action: **Start a program**:
   - **Program/script**: `node.exe` (or full path like `C:\Program Files\nodejs\node.exe`)
   - **Add arguments**: `connector/sync.mjs incremental`
   - **Start in**: `C:\Users\PC\Desktop\MeemX-ERP` (full path to your project root)
5. Check **Run whether user is logged on or not** and save the task.

### 5. Security & Safety Notes
- **Localhost Only**: TallyPrime's HTTP interface has **no authentication or encryption**. The connector strictly refuses non-loopback addresses (`127.0.0.1`, `localhost`, `::1`) by default.
- **Never Port-Forward**: Never expose or port-forward port `9000` to the internet.
- **Encrypted Transport**: Data traveling to Supabase travels encrypted over HTTPS.
- **Read-Only Guarantee**: The connector strictly uses `<TALLYREQUEST>Export</TALLYREQUEST>` and contains runtime guards prohibiting any write, import, or execute operations against Tally.
- **Secret Redaction**: Passwords, tokens, and database credentials are automatically redacted from console outputs and logs.

