import asyncio, os, sys
from playwright.async_api import async_playwright


async def main(wid, out):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 1800, "height": 1000})
        pg = await ctx.new_page()
        await pg.goto("http://127.0.0.1:5678/signin", wait_until="networkidle")
        await pg.fill('input[type="email"]', os.environ.get("N8N_TEST_EMAIL", "test@loopwell.dev"))
        await pg.fill('input[type="password"]', os.environ["N8N_TEST_PASSWORD"])  # owner password of your local test n8n
        await pg.keyboard.press("Enter")
        await pg.wait_for_timeout(4000)
        await pg.goto(f"http://127.0.0.1:5678/workflow/{wid}", wait_until="networkidle")
        await pg.wait_for_timeout(5000)
        for sel in ['button:has-text("Got it")', 'button:has-text("Close")', '[aria-label="Close"]']:
            try:
                el = await pg.query_selector(sel)
                if el:
                    await el.click()
            except Exception:
                pass
        await pg.keyboard.press("Shift+1")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=out)
        issues = await pg.evaluate("""() => [...document.querySelectorAll('[data-test-id="node-issues"], [data-test-id="canvas-node-status-issues"]')].map(e => (e.closest('[data-test-id="canvas-node"]')||{}).getAttribute ? e.closest('[data-test-id="canvas-node"]').getAttribute('data-node-name') : '?')""")
        print("nodes with issues:", issues)
        await b.close()

asyncio.run(main(sys.argv[1], sys.argv[2]))
