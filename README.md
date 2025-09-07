RoomShop

URL: https://nano-banana-hack.onrender.com/

Nano-banana for interior decoration. Takes a user's prompt to search a fitting addition to their room, update it, see it from a top-down isomorphic view and view it in 3d.

Features
- IKEA-first search by default; Google custom search engine for shopping results
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

