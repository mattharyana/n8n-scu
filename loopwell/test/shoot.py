import asyncio, sys, json
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:5678/webhook/loopwell"


async def main(mode):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1440, "height": 1000})
        logs = []
        pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
        pg.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(URL, wait_until="domcontentloaded")
        await pg.wait_for_timeout(2500)
        if mode == "run":
            await pg.click("#btnReset")
            await pg.wait_for_timeout(300)
            await pg.wait_for_timeout(2500)
            await pg.screenshot(path="/home/claude/loopwell/test/shot_loaded.png", full_page=True)
            await pg.click("#btnRun")
            await pg.wait_for_timeout(1200)
            await pg.screenshot(path="/home/claude/loopwell/test/shot_running.png", full_page=False)
            await pg.wait_for_timeout(6000)
        await pg.screenshot(path="/home/claude/loopwell/test/shot_full.png", full_page=True)
        rows = await pg.query_selector_all(".row")
        if rows:
            await rows[0].click()
            await pg.wait_for_timeout(500)
            await pg.screenshot(path="/home/claude/loopwell/test/shot_detail.png", full_page=True)
            edit = await pg.query_selector("#btnEdit")
            if edit:
                await edit.click()
                await pg.fill("#edBody", "Hi Dana -\n\nI wanted to reach out about 2027.\nWhat do your next few Fridays look like?\n\nSam")
                await pg.wait_for_timeout(300)
                await pg.screenshot(path="/home/claude/loopwell/test/shot_edit.png", full_page=True)
        await pg.set_viewport_size({"width": 390, "height": 844})
        await pg.wait_for_timeout(500)
        await pg.screenshot(path="/home/claude/loopwell/test/shot_mobile.png", full_page=False)
        print("\n".join(logs[-20:]))
        await b.close()

asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "view"))
