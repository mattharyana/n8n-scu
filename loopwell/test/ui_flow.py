"""Browser test of the live workflow map against the local test workflow.

Start the mock with a delay so each stage lasts long enough to see (MOCK_DELAY=4), then:
python3 test/ui_flow.py
It loads the demo CRM, runs a batch with the map open and screenshots each stage it catches.
"""
import asyncio, pathlib, time
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:5678/webhook/loopwell"
OUT = pathlib.Path(__file__).parent / "shots"


async def main():
    OUT.mkdir(exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1440, "height": 1100})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        await pg.goto(URL, wait_until="domcontentloaded")
        await pg.wait_for_selector(".row")
        print("closed summary:", await pg.text_content("#flow summary"))
        await pg.click("#flow summary")
        await pg.wait_for_selector("#flowSvg .gn")
        await pg.wait_for_timeout(900)
        loop = await pg.query_selector(".loop")
        await loop.screenshot(path=str(OUT / "flow-idle.png"))
        print("idle status:", await pg.text_content("#flowStatus"))
        print("nodes drawn:", await pg.eval_on_selector_all("#flowSvg .gn", "e => e.length"),
              "edges:", await pg.eval_on_selector_all("#flowSvg .ge", "e => e.length"),
              "chips:", await pg.eval_on_selector_all("#flowOv .gchip", "e => e.length"))

        # Fresh demo data, then a batch with the map open.
        await pg.click("#btnReset")
        await pg.wait_for_selector("dialog#ask[open]")
        await pg.fill("#askPass", "test-pass")
        await pg.click("#askOk")
        await pg.wait_for_function("document.querySelector('#toast').textContent.includes('Demo CRM loaded')", timeout=20000)
        await pg.wait_for_timeout(800)
        await pg.click("#btnRun")
        seen, t0 = {}, time.time()
        while time.time() - t0 < 240:
            status = await pg.text_content("#flowStatus")
            for key in ["research", "drafting", "quality checks", "fact check"]:
                if key in status and key not in seen:
                    await pg.wait_for_timeout(900)  # let the camera finish gliding
                    name = "flow-" + key.split()[0] + ".png"
                    await loop.screenshot(path=str(OUT / name))
                    seen[key] = round(time.time() - t0, 1)
                    print(f"{seen[key]:>6}s  {status}  -> {name}")
            if seen and status.startswith("Idle"):
                break
            await pg.wait_for_timeout(700)
        await pg.wait_for_timeout(1500)
        await loop.screenshot(path=str(OUT / "flow-done.png"))
        print("done status:", await pg.text_content("#flowStatus"))
        print("feed:", [t.strip() for t in await pg.eval_on_selector_all("#feedList li", "e => e.map(x => x.innerText.replace(/\\n/g, ' '))")])

        # Zoom in: labels appear; hover a node: tooltip.
        await pg.click("#flowFit")
        await pg.wait_for_timeout(900)
        for _ in range(3):
            await pg.click("#flowIn")
        await pg.wait_for_timeout(400)
        print("labels on:", await pg.eval_on_selector("#flowOv", "e => e.classList.contains('labels')"),
              "follow pressed:", await pg.get_attribute("#flowFollow", "aria-pressed"))
        box = await (await pg.query_selector("#canvas")).bounding_box()
        await pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        await pg.mouse.down(); await pg.mouse.move(box["x"] + box["width"] / 2 + 120, box["y"] + box["height"] / 2 + 40, steps=6); await pg.mouse.up()
        await pg.click("#flowFit")
        await pg.wait_for_timeout(900)
        await pg.click("#flowOv .sl[data-s='2']")
        await pg.wait_for_timeout(1000)
        hov = await pg.evaluate("""() => { const n = [...document.querySelectorAll('#flowSvg .gn')].find(g => { const r = g.getBoundingClientRect(); const c = document.querySelector('#canvas').getBoundingClientRect(); return r.left > c.left + 40 && r.right < c.right - 340 && r.top > c.top + 60 && r.bottom < c.bottom - 40; }); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }""")
        if hov:
            await pg.mouse.move(hov["x"], hov["y"])
            await pg.wait_for_timeout(300)
            print("tooltip:", await pg.text_content("#flowTip"))
        await loop.screenshot(path=str(OUT / "flow-zoomed.png"))
        print("page errors:", errors or "none")
        await b.close()


asyncio.run(main())
