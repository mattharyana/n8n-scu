# Ahoj

Turns 3 to 10 raw phone clips into one finished promo video, cut in the style of a reference YouTube video or a text description. Frontend for the n8n Santa Clara Buildathon. Next.js (App Router, TypeScript) + Tailwind.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no `.env.local` the app runs in mock mode: fake uploads, fake style analysis, fake render, sample video.

## Go live

Copy `.env.local.example` to `.env.local`, fill in, restart `npm run dev`.

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD` | cloud name from Sam (empty = fake uploads) |
| `NEXT_PUBLIC_CLOUDINARY_PRESET` | `ahoj_unsigned` |
| `NEXT_PUBLIC_N8N_BASE` | n8n production webhook base (empty = mock mode) |
| `NEXT_PUBLIC_N8N_PROXY` | optional, `1` to route n8n calls through `/api/n8n/*` if CORS blocks the browser |

## Deploy to Vercel

```bash
npx vercel
npx vercel --prod
```

Or push to GitHub and import the repo at vercel.com/new. Either way, add the env vars under Project Settings > Environment Variables and redeploy. `NEXT_PUBLIC_*` values are baked in at build time, so every change needs a redeploy.

## Where things live

- `lib/api.ts`: every n8n call (`analyseStyle`, `createPromo`, `getStatus`), mock mode, and the `SEND_STYLE_PROMPT` flag for the "Describe it" option.
- `lib/cloudinary.ts`: unsigned browser upload, 40 MB limit, thumbnails.
- `lib/types.ts`: types that mirror the API contract.
- `app/api/n8n/[...path]/route.ts`: CORS fallback proxy.
- `components/`: `AhojApp` (state and job runner), `UploadStep`, `ProgressStep`, `ResultStep`, `ui`.
