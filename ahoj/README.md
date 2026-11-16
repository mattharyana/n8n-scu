# Ahoj

Turns 3 to 20 raw phone clips into one finished promo video, edited in the style of a reference YouTube video. Built at the n8n Santa Clara Buildathon by Sam and Lukáš.

Live site: https://ahoj-five.vercel.app

## What is in this repository

- `frontend/`: the website. Next.js (App Router, TypeScript) and Tailwind, deployed to Vercel. See `frontend/README.md` for how to run it.
- `backend/`: the n8n workflow export (`ahoj-clips-to-promo.n8n.json`). Import it into n8n and connect your own credentials for the services it calls.

## How it fits together

1. The browser uploads clips straight to Cloudinary.
2. The frontend calls the n8n webhooks: `POST /style` analyses the reference video, `POST /promo` plans the edit and starts the render, and `GET /promo-status` reports progress.
3. When the render is done, the frontend plays the finished MP4 and offers the caption and hashtags.
