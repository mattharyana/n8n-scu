"""Browser test of the dashboard's Approve & send flow against the local test workflow.

Run after a local batch has finished (see README). Passcode in the local build: test-pass.
Usage: python3 test/ui_approve.py [account company to approve, default Clay]
"""
import asyncio, sys, pathlib
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:5678/webhook/loopwell"
OUT = pathlib.Path(__file__).parent / "shots"


async def main(company):
    OUT.mkdir(exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await pg.goto(URL, wait_until="domcontentloaded")
        await pg.wait_for_selector(".row")
        await pg.click(f".row:has-text('{company}')")
        await pg.wait_for_selector("#btnSend")
        await pg.screenshot(path=str(OUT / "1-ready.png"))

        await pg.click("#btnSend")
        await pg.wait_for_selector("dialog#ask[open]")
        assert await pg.is_visible("#askPass"), "passcode field should show on first use"
        await pg.screenshot(path=str(OUT / "2-confirm.png"))

        await pg.fill("#askPass", "wrong")
        await pg.click("#askOk")
        await pg.wait_for_function("document.querySelector('#askErr').textContent.includes('Wrong passcode')")
        await pg.screenshot(path=str(OUT / "3-wrong.png"))

        await pg.fill("#askPass", "test-pass")
        await pg.press("#askPass", "Enter")
        await pg.wait_for_selector("dialog#ask:not([open])", state="attached")
        await pg.wait_for_selector(".sent-note", timeout=15000)
        toast = await pg.text_content("#toast")
        pill = await pg.text_content(".who .pill")
        await pg.screenshot(path=str(OUT / "4-sent.png"))
        print("toast:", toast, "| status:", pill)

        # Second action in the same page load: passcode is remembered, only a confirm shows.
        other = await pg.query_selector(".row:has-text('Ready for your review')")
        if other:
            await other.click()
            await pg.wait_for_selector("#btnReject")
            await pg.click("#btnReject")
            await pg.wait_for_selector("dialog#ask[open]")
            assert not await pg.is_visible("#askPass"), "passcode should be remembered for this page load"
            await pg.click("#askCancel")
            await pg.wait_for_selector("dialog#ask:not([open])", state="attached")
            print("second action: confirm only, cancel works")
        print("page errors:", errors or "none")
        await b.close()


asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "Clay"))
