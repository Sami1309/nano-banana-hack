# RoomShop – USER TODO

What you need to fetch or set up manually to run RoomShop locally and use it from your phone.

## Accounts & API Keys
- Google Programmable Search (Custom Search JSON API):
  - Needed: `CSE_API_KEY` (API key) and `CSE_CX` (Search engine ID).
  - In your PSE control panel, enable “Search the entire web” (optional but recommended).
  - Quota/cost: first 100 queries/day free, then paid.

- Google Gemini:
  - Needed: `GEMINI_API_KEY`.
  - Used to generate targeted queries from user intent and budget.

- fal.ai: create an API key.
  - Needed: `FAL_KEY`.
  - Models used: `fal-ai/nano-banana/edit` and `fal-ai/hunyuan3d-v21`.
  - Ensure your account has access/credits for these endpoints.

- ElevenLabs: create an API key.
  - Needed: `ELEVEN_API_KEY`.
  - Endpoint used: Speech-to-Text (`/v1/speech-to-text`, model `scribe_v1`).

## Environment
- Node.js 18+ recommended (for native fetch, Blob, FormData, MediaRecorder support on frontend).
- Copy `.env.example` to `.env` and fill values:
  - `PORT=8787`
  - `CSE_API_KEY=...`
  - `CSE_CX=...`
  - `GEMINI_API_KEY=...`
  - `FAL_KEY=...`
  - `ELEVEN_API_KEY=...`

## Install & Run
- Install dependencies:
  - `npm install`
- Start server:
  - `npm start` (or `node server.js`)
- Health check:
  - Open `http://localhost:8787/health` on your computer.

## Use on Phone (same Wi‑Fi)
- Find your computer’s LAN IP:
  - macOS: `ipconfig getifaddr en0` (or check Wi‑Fi details)
  - Linux: `ip addr show | rg 'inet '` 
  - Windows: `ipconfig` (look for IPv4 Address)
- Open on phone: `http://<your-computer-ip>:8787`
- Ensure your firewall allows inbound connections to port 8787 on the local network.

## Camera & Microphone Notes (mobile)
- Camera (getUserMedia) may be blocked on plain HTTP for non-localhost origins.
  - If camera preview fails on your phone, use the Upload button to take/select a photo.
  - Optional: set up HTTPS locally (e.g., via a local proxy like `mkcert` or `ngrok`) if you want in-page camera capture from the phone.
- Microphone (MediaRecorder) support varies by mobile browser/version.
  - If voice capture fails, just type your request.

## Search Tips
- Programmable Search returns up to 10 results per call; the backend paginates/expands via multiple queries.
- The server follows result pages, reads `schema.org/Product` JSON-LD to extract price and images.
- Price bands are computed from your budget; tune in the `/api/products` route if desired.

## fal.ai & 3D Output
- The compose step mixes your room photo + product images (`nano-banana/edit`).
- Finalize runs an isometric edit and then Hunyuan3D v2.1 to produce a GLB.
- Make sure your fal.ai credit/limits cover image + 3D invocations.

## ElevenLabs STT
- Endpoint: `https://api.elevenlabs.io/v1/speech-to-text` with header `xi-api-key`.
- Model: `scribe_v1`.

## After Setup – Flow
- Open the web page, snap or upload your room photo.
- Describe what you want and set a budget.
- Toggle "Images" on to generate room composites, or off to list products only.
- Tap Find options → with Images on, shows Low/Mid/High composites; with Images off, shows product lists by price tier.
- Tap Finalize → get isometric image + downloadable GLB link.

## Optional Hardening (later)
- Lock down CORS to your LAN IP or specific origins.
- Add PWA manifest + service worker for installable behavior.
- Swap to affiliate URLs if you’re in eBay Partner Network.
