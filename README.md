RoomShop

URL: https://nano-banana-hack.onrender.com/

Concise, camera-first concepting for room upgrades. Snap or upload your room photo, describe a vibe, and get IKEA-first product tiers (Low/Mid/High), quick composites, isometric view, voice input, and iterative refinements.

Features
- IKEA-first search by default; deduped product results.
- Voice input (press-and-hold via ElevenLabs STT).
- L/M/H composites with your room photo (fal nano-banana/edit).
- Finalize to an isometric view; optional “Show in 3D” to view a GLB in-app.
- Reorganize: preserve existing furniture and reposition layout to accommodate selected tier.
- Refine: ask for a different style, higher/lower pricing, or add categories (e.g., “add shelving; pricier lamp, cheaper shelves”).

Quick Start
1) Copy `.env.example` to `.env` and set keys:
   - `FAL_KEY` (fal.ai)
   - `ELEVEN_API_KEY` (ElevenLabs STT)
   - `CSE_API_KEY` + `CSE_CX` (Google Custom Search)
   - `GEMINI_API_KEY` (Google Generative AI; used for queries + brief rationale)
   - Optional: `ENABLE_3D=true` to auto-generate 3D during finalize (or use “Show in 3D” on demand)
2) Install deps and run
   - `npm install`
   - `node server.js`
3) Open `http://localhost:8787`

Workflow
- Take a photo (or upload), describe what you want, pick a budget, and hit “Find options”.
- Toggle tier buttons to switch composite overlay; open the drawer to browse products.
- “Finalize” makes an isometric view based on the selected tier.
- “Show in 3D” (after finalize) generates a GLB and shows it in-app.
- “Reorganize” preserves all existing items and repositions layout to fit selected-tier products.
- “Refine” lets you iterate: style shifts, budget nudges, and added categories (e.g., shelving) merge with current tier.

Notes
- Frontend avoids purple, glow, and gradients.
- By default, retailer scope is IKEA-only. You can POST `ikeaOnly: false` to `/api/products` to broaden retailers.

