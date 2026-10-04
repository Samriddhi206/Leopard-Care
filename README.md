# Leopard Care

A care-coordination dashboard for patients and the people who look after them.
Patients get a simple daily checklist they can hear read aloud; caregivers get a
live view of how the day is going, for every patient they support.

Leopard Care is a Vite frontend (plain HTML, CSS and JavaScript modules) backed by
a small Express API.

## Features

- **Role-based onboarding.** The app opens by asking "Are you a Patient or a
  Caregiver?" and remembers the answer. You can switch roles or log out from
  Settings.
- **Patient view.** A tick-off checklist of the day's tasks, a "next medication"
  card with supply tracking, an "I'm OK, check in" button, and one place to call
  or message a caregiver.
- **Caregiver view.** Add tasks, medications and appointments; edit, resolve or
  dismiss "Needs attention" items; and choose which tasks or appointments raise
  automatic alerts.
- **Multi-patient management.** Caregivers switch between linked patients from a
  dropdown under the top bar. Two demo patients, Marta Johnson and John Doe, are
  ready to use out of the box.
- **Caregiver relief sync.** When a patient completes a task, logs a medication or
  checks in, caregivers see it straight away: a toast, a "Recent activity" feed
  and a count in the top bar, delivered over server-sent events.
- **Read aloud with ElevenLabs.** "🔊 Read aloud" buttons speak the day's schedule,
  the next medication, attention items and recent activity. With an ElevenLabs API
  key you get natural voices; without one, the browser's built-in Web Speech API is
  used automatically, for free.
- **Medication supplies.** Logging a dose uses one from the supply, and low stock
  is flagged.
- **Accessible by design.** 44px minimum touch targets, WCAG AA text contrast,
  keyboard focus that survives re-renders, and screen-reader labels throughout.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (includes npm)
- Optional: an [ElevenLabs](https://elevenlabs.io/) API key for premium voices

## Getting started

```sh
git clone https://github.com/Samriddhi206/Leopard-Care.git
cd Leopard-Care
npm install
cp .env.example .env
npm run dev:all
```

Then open <http://localhost:3000>.

`npm run dev:all` starts the API on port 3001 and the Vite dev server on port 3000.
Vite proxies every `/api` request to the API, so always use port 3000 in the
browser.

## Configuration

Settings are read from `.env`. Copy `.env.example` to create it. `.env` is
gitignored, so your keys never get committed.

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | API port. Defaults to `3001`. |
| `ELEVENLABS_API_KEY` | No | Enables ElevenLabs voices. Leave the placeholder to use free browser speech instead. |
| `ELEVENLABS_VOICE_ID` | No | ElevenLabs voice to use. |
| `ELEVENLABS_MODEL_ID` | No | ElevenLabs model. Defaults to `eleven_flash_v2_5` (low latency, lower cost). |
| `JWT_SECRET` | No | Reserved for authentication, which is not implemented yet. |
| `CORS_ORIGIN` | No | Comma-separated origins allowed to call the API directly. Defaults to `http://localhost:3000`. |

### About the ElevenLabs key

The key is optional. Without it, Read aloud uses the browser's Web Speech API.
The same fallback kicks in automatically when the voice service is rate-limited,
unreachable or returns audio the browser can't play. The key stays on the server
and is never sent to the browser.

To protect your ElevenLabs credits, the voice endpoint allows 6 requests per
minute and 150 per day for each client, and repeated phrases are served from a
cache.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev:all` | Starts the API and the web app together |
| `npm run server` | Starts the API only |
| `npm run dev` | Starts the Vite dev server only |
| `npm run build` | Builds the frontend into `dist/` |
| `npm run preview` | Serves the built frontend, with the same `/api` proxy |

## Trying it out

1. Open <http://localhost:3000> and choose **Caregiver**.
2. Use the **Caring for** dropdown to switch between Marta Johnson and John Doe.
3. To see relief sync, open a private or incognito window (roles are remembered
   per browser), go to the same address and choose **Patient**. Tick off a task or
   tap **I'm OK, check in**, and watch the caregiver window update.
4. Press **🔊 Read aloud** on any card to hear it.

To start over, use **Settings → Reset demo data** (this clears what the browser
saved), and stop the server and delete `server/data/` to reset the schedules.

## Project structure

```
index.html          App shell and markup
styles.css          Styles
src/
  main.js           Entry point: role selection and the notification badge
  app.js            Dashboard rendering and interactions
  api.js            API client
  voice.js          Read aloud (ElevenLabs, with Web Speech fallback)
server/
  index.js          Express app: routes, security middleware, live activity stream
  store.js          In-memory data store, saved to server/data/db.json
  validation.js     Input validation and sanitizing
  elevenlabs.js     ElevenLabs text-to-speech client with caching
vite.config.js      Dev and preview proxy for /api
```

## API

All endpoints live under `/api/v1` and exchange JSON unless noted.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/patients` | Linked patients |
| `PUT` | `/patients/:id` | Update a patient's name, phone, address or date of birth |
| `POST` | `/patients/:id/check-in` | Record a patient check-in |
| `GET` | `/tasks?patientId=` | A patient's daily tasks |
| `POST` | `/tasks` | Create a task |
| `PUT` | `/tasks/:id` | Update a task's status (`pending`, `done`, `late`), title or time |
| `GET` | `/medications?patientId=` | A patient's medications |
| `POST` | `/medications` | Create a medication |
| `PUT` | `/medications/:id` | Log or un-log a dose (adjusts the supply) |
| `GET` | `/appointments?patientId=` | Appointments, sorted by date and time |
| `POST` | `/appointments` | Create an appointment |
| `GET` | `/activity?patientId=` | Recent relief notifications |
| `GET` | `/activity/stream?patientId=` | Live relief notifications (server-sent events) |
| `POST` | `/voice/announce` | Text to speech; returns `audio/mpeg` |

Status changes made with the header `X-Actor-Role: patient` create relief
notifications for caregivers.

## Data

The API keeps data in memory and writes it to `server/data/db.json`, which is
gitignored. On first run it is seeded with the two demo patients. Per-device
preferences (care team, care notes, alert settings) are stored in the browser's
localStorage.

## Security

- The API sets security headers with `helmet`, rate-limits requests, caps request
  bodies at 10 KB, and validates and sanitizes all input.
- Secrets live only in `.env`, which is gitignored.
- **There is no authentication yet.** Anyone who can reach the API can read and
  change all data, and the patient/caregiver role is not verified. Do not deploy
  this with real patient information until authentication is in place.

## Contributing

Issues and pull requests are welcome. Please keep changes focused, match the
existing code style, and check that `npm run build` passes and the app runs with
`npm run dev:all` before opening a pull request.

## License

No license has been chosen yet. Until one is added, all rights are reserved by
the authors.
