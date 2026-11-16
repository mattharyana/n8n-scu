#!/usr/bin/env python3
"""Mock OpenAI + mock homepages + mock RSS for local end-to-end testing of the Loopwell workflow."""
import json, os, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email.utils import formatdate

LOG = []

PAGES = {
    "acc_ramp": ("Ramp | Time is money. Save both.", ["Ramp Agents now close your books", "The finance automation platform built for speed", "Meet Ramp Intelligence: AI agents for finance teams"]),
    "acc_vercel": ("Vercel: Build and deploy the best web experiences", ["Your complete platform for the web", "Ship v0 apps straight to production with the AI Cloud"]),
    "acc_rippling": ("Rippling | Manage HR, IT, and Finance in one place", ["The first all-in-one workforce platform", "Global payroll in 185 countries, now with local benefits"]),
    "acc_linear": ("Linear - Plan and build products", ["Linear is a purpose-built tool for planning and building products", "Introducing Linear Agents for product teams"]),
    "acc_retool": ("Retool | Build internal software better, with AI", ["Build AI apps and agents on your data", "Retool Agents are now generally available"]),
    "acc_clay": ("Clay | Go to market with unique data", ["Turn your growth ideas into reality", "Sculptor: the GTM engineer in your pocket"]),
}


EXTRA = {}  # account_id -> extra headline, set via GET /change/<account_id> to simulate a homepage update


def html_for(acc):
    title, heads = PAGES.get(acc, ("Company", ["Welcome"]))
    heads = heads + ([EXTRA[acc]] if acc in EXTRA else [])
    hs = "".join(f"<h2>{h}</h2><p>Lorem ipsum detail about {h.lower()} and more product text for testing.</p>" for h in heads)
    return f"<!doctype html><html><head><title>{title}</title><meta name=\"description\" content=\"{heads[0]}.\"><script>var x=1;</script></head><body><h1>{heads[0]}</h1>{hs}<footer>Footer text</footer></body></html>"


def rss_for(q):
    now = time.time()
    items = []
    name = q.split(' when')[0]
    news = [(f"{name} raises new funding to expand AI products - TechCrunch", 12), (f"{name} announces layoffs in sales team - Reuters", 30)]
    if name.startswith("Clay"):
        news.append((f"Clay launches a GTM agent marketplace for revenue teams - GTM Weekly", 2))  # fresh, for the watcher test
    if name.startswith("Retool"):
        news.append((f"Ravens must Retool the defense, off-topic sports story - Sports Daily", 0))  # name match, wrong meaning
    if name.startswith("Vercel"):
        news.append((f"Vercel ships a new AI SDK release for agent builders - Dev News", 0))  # fresh and relevant
    for k, (t, age) in enumerate(news):
        items.append(f"<item><title>{t}</title><link>https://news.example.com/{k}</link><pubDate>{formatdate(now - age * 86400)}</pubDate><source url=\"https://x\">Example News</source></item>")
    return "<?xml version=\"1.0\"?><rss><channel>" + "".join(items) + "</channel></rss>"


def first(name):
    return name.split()[0]


def draft_for(acc, flawed):
    fn = first(acc["contact_name"])
    co = acc["company"]
    if flawed:
        body = f"Hi {fn} -\n\nI wanted to reach out since it has been a while.\nWe have grown a lot and now have 37 writers.\nWould love to hop on a call.\n\nBest,\nJayden"
    else:
        tz = acc.get("timezone") or ""
        body = (f"Hi {fn},\n\nSaw the new homepage leaning hard into AI agents for your customers.\n"
                f"You'd mentioned waiting until planning season, so it felt like the right moment.\n"
                f"Curious what 2027 looks like for content on your side.\n"
                f"What do your next few Fridays look like{', ' + tz if tz else ''}?\n\nJayden")
    return {"subject": f"{co} <> Northfold", "body": body, "angle": "Open on their homepage change, then 2027 planning.", "notes": ["mock draft"]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/home/"):
            return self._send(200, html_for(self.path.split("/home/")[1].split("?")[0]), "text/html")
        if self.path.startswith("/rss"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query).get("q", ["Company"])[0]
            return self._send(200, rss_for(q), "application/rss+xml")
        if self.path.startswith("/v1/models"):
            return self._send(200, json.dumps({"data": [{"id": "gpt-4.1-mini", "object": "model"}]}))
        if self.path.startswith("/change/"):
            acc = self.path.split("/change/")[1]
            EXTRA[acc] = "Introducing Ramp Treasury: earn 4.1% on idle cash"
            return self._send(200, json.dumps({"changed": acc}))
        if self.path == "/log":
            return self._send(200, json.dumps(LOG[-200:]))
        self._send(404, "{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        time.sleep(float(os.environ.get("MOCK_DELAY", "0")))  # slow the mock LLM down to watch a run on the live map
        if "responses" in self.path:
            return self._responses(req)
        msgs = req.get("messages", [])
        system = next((m["content"] for m in msgs if m.get("role") == "system"), "")
        if isinstance(system, list):
            system = " ".join(p.get("text", "") for p in system)
        user = msgs[-1]["content"] if msgs else ""
        if isinstance(user, list):
            user = " ".join(p.get("text", "") for p in user)
        out = self.respond(system, user)
        LOG.append({"agent": out[0], "user": user[:300], "out": out[1][:300], "style": '"style_guide"' in user})
        resp = {"id": "chatcmpl-mock", "object": "chat.completion", "created": int(time.time()), "model": req.get("model"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": out[1]}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}
        self._send(200, json.dumps(resp))

    def _responses(self, req):
        # OpenAI Responses API (what n8n uses for gpt-5-mini with reasoningEffort).
        def text_of(c):
            if isinstance(c, list):
                return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            return c or ""
        items = req.get("input", [])
        if isinstance(items, str):
            items = [{"role": "user", "content": items}]
        system = (req.get("instructions") or "") + " " + " ".join(
            text_of(m.get("content")) for m in items if m.get("role") in ("system", "developer"))
        user = next((text_of(m.get("content")) for m in reversed(items) if m.get("role") == "user"), "")
        out = self.respond(system, user)
        LOG.append({"agent": out[0], "user": user[:300], "out": out[1][:300], "style": '"style_guide"' in user})
        resp = {"id": "resp_mock", "object": "response", "created_at": int(time.time()), "status": "completed",
                "model": req.get("model"),
                "output": [{"type": "message", "id": "msg_mock", "status": "completed", "role": "assistant",
                            "content": [{"type": "output_text", "text": out[1], "annotations": []}]}],
                "usage": {"input_tokens": 10, "output_tokens": 10, "total_tokens": 20}}
        self._send(200, json.dumps(resp))

    def respond(self, system, user):
        if "Research Agent" in system:
            d = json.loads(user)
            acc = d["account"]
            srcs = d.get("sources", [])
            if acc["company"] == "Clay":
                return "research", json.dumps({"found": False, "sensitivity": "adverse_only"})
            if acc["company"] == "Retool" and srcs:
                return "research", json.dumps({"found": True, "type": "company_news", "signal": "They won an award.", "evidence_quote": "Retool wins the Best Internal Tool award of the year from Fake Magazine", "source_id": srcs[0]["id"], "sensitivity": "ok", "why_it_matters": "x"})
            home = next((s for s in srcs if s["type"] == "homepage"), None)
            if not home:
                return "research", json.dumps({"found": False, "sensitivity": "ok"})
            words = home["text"].split(" | ")[1] if " | " in home["text"] else home["text"][:80]
            return "research", json.dumps({"found": True, "type": "website_change", "signal": f"Their homepage now leads with: {words}", "evidence_quote": words, "source_id": home["id"], "sensitivity": "ok", "why_it_matters": "Shows Jayden looked at their site today."})
        if "Style Learner" in system:
            d = json.loads(user)
            rules = list(d.get("current_rules") or [])
            ai = [l for l in d["ai_draft"]["body"].split("\n") if l.strip()]
            ed = [l for l in d["edited_draft"]["body"].split("\n") if l.strip()]
            added = []
            if len(ai) > 1 and len(ed) > 1 and ai[1] != ed[1]:
                rule = "Open with what you noticed, in plain words."
                if rule not in rules:
                    rules.append(rule); added.append(rule)
            return "learn", json.dumps({"rules": rules, "added": added})
        if "Relevance Filter" in system:
            if user.strip() == "NONE":
                return "relevance", json.dumps({"keep": {}})
            d = json.loads(user)
            # keep everything except headlines marked as off-topic in the mock feed
            return "relevance", json.dumps({"keep": {a["account_id"]: [h["n"] for h in a["headlines"] if "off-topic" not in h["text"]] for a in d["accounts"]}})
        if "Fact Checker" in system:
            d = json.loads(user)
            body = d["draft"]["body"]
            src = d["sources"]
            lines = [l for l in body.split("\n") if l.strip()][1:-1]
            claims = []
            if lines and src.get("web_signal"):
                claims.append({"draft_quote": " ".join(lines[0].split()[:8]), "claim": "Their homepage now leads with AI agents.",
                               "source": "web_signal", "evidence": " ".join(src["web_signal"].split()[:10])})
            if len(lines) > 1 and src.get("crm_call_notes"):
                claims.append({"draft_quote": " ".join(lines[1].split()[:6]), "claim": "They asked to wait until planning season.",
                               "source": "crm_call_notes", "evidence": " ".join(src["crm_call_notes"].split()[:9])})
            if "Linear" in d["draft"]["subject"] and len(lines) > 2:
                # deliberately unsupported, to exercise the red state
                claims.append({"draft_quote": " ".join(lines[2].split()[:5]), "claim": "They are planning 2027 content now.",
                               "source": "none", "evidence": ""})
            return "factcheck", json.dumps({"claims": claims})
        if "revising, not drafting" in system:
            if "NO_REVISION_NEEDED" in user:
                return "revise", json.dumps({"keep": True})
            d = json.loads(user)
            return "revise", json.dumps({**draft_for(d["account"], False), "notes": ["Removed dash greeting", "Cut banned phrase"]})
        if "Drafting Agent" in system:
            d = json.loads(user)
            co = d["account"]["company"]
            if co == "Rippling":
                # Real gpt-5-mini failure: a stray unescaped quote mid-body makes the JSON invalid.
                return "draft", json.dumps(draft_for(d["account"], False)).replace("\\nYou'd mentioned", "\\n\"You'd mentioned")
            if co == "Vercel":
                # Truncated output that no parser can recover: the body falls back to raw text.
                return "draft", json.dumps(draft_for(d["account"], False))[:120]
            flawed = co in ("Ramp", "Linear")
            return "draft", json.dumps(draft_for(d["account"], flawed))
        if "Quality Judge" in system:
            if "ALREADY_PASSED" in user:
                return "judge", json.dumps({"keep": True})
            d = json.loads(user)
            body = d["draft"]["body"]
            if " -\n" in body or "reach out" in body:
                return "judge", json.dumps({"score": 5, "failures": [{"check": "about_them", "detail": "Second line is about Northfold's headcount."}, {"check": "human", "detail": "Opening is generic."}], "strengths": [], "verdict": "Generic and self-focused."})
            return "judge", json.dumps({"score": 9, "failures": [], "strengths": ["Specific opener", "Warm Friday ask"], "verdict": "Specific, short, and about them."})
        return "unknown", json.dumps({"error": "unknown agent"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
