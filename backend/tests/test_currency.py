"""Switching the selling currency converts every price, instead of only changing the symbol."""
from app.saas import friendly_price
from conftest import fails, ok


def test_friendly_prices():
    assert [friendly_price(v) for v in (0, 504, 1680, 168, 252, 5.94, 0.2, 37.4)] == [0, 499, 1699, 149, 249, 6, 0.5, 37]


def test_preview_shows_rupee_prices_without_changing_anything(owner, plans):
    assert ok(owner.api.get("/api/platform/currency/rate?to=INR"))["rate"] == 84
    preview = ok(owner.api.post("/api/platform/currency", {"currency": "INR", "rate": 84, "preview": True}))
    rows = {r["name"]: r for r in preview["rows"]}
    assert (rows["Starter"]["monthly"], rows["Starter"]["yearly"]) == (499, 4990)
    assert (rows["Enterprise"]["monthly"], rows["Enterprise"]["yearly"]) == (1699, 16990)
    assert rows["Approvals Pro"]["monthly"] == 149 and rows["Free"]["monthly"] == 0
    assert ok(owner.api.get("/api/platform/settings"))["currency"] == "USD"
    assert ok(owner.api.get("/api/platform/plans"))["plans"][2]["price_monthly"] in (6, plans["starter"]["price_monthly"])


def test_changing_the_currency_converts_plans_addons_and_coupons(owner, workspace):
    coupon = ok(owner.api.post("/api/platform/coupons", {"code": "FLAT10", "amount_off": 10}), 201)
    try:
        ok(owner.api.post("/api/platform/currency", {"currency": "EUR", "rate": 2, "friendly": False}))
        assert ok(owner.api.get("/api/platform/settings"))["currency"] == "EUR"
        starter = next(p for p in ok(owner.api.get("/api/platform/plans"))["plans"] if p["key"] == "starter")
        assert (starter["price_monthly"], starter["price_yearly"]) == (12, 120)
        assert next(a for a in ok(owner.api.get("/api/platform/addons"))["addons"] if a["key"] == "time_budgets")["price_monthly"] == 6
        assert next(c for c in ok(owner.api.get("/api/platform/coupons")) if c["code"] == "FLAT10")["amount_off"] == 20
        ws = workspace()
        assert ok(ws.admin.api.get("/api/billing"))["settings"]["currency"] == "EUR"
        fails(ws.admin.api.post("/api/platform/currency", {"currency": "INR", "rate": 84}), 404)
    finally:
        ok(owner.api.post("/api/platform/currency", {"currency": "USD", "rate": 0.5, "friendly": False}))
        ok(owner.api.delete(f"/api/platform/coupons/{coupon['id']}"), 204)
    starter = next(p for p in ok(owner.api.get("/api/platform/plans"))["plans"] if p["key"] == "starter")
    assert (starter["price_monthly"], starter["price_yearly"]) == (6, 60)
