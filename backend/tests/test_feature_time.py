"""Time logged on features: directly, and through their issues, in budgets, timesheets and workload."""
from datetime import date, timedelta

from conftest import fails, ok

TODAY = date.today().isoformat()


def setup(ws):
    project = ws.project("FT")
    pid = project["id"]
    dev = ws.add_person(full_name="Dana Dev")
    other = ws.add_person(full_name="Omar Other")
    viewer = ws.add_person(full_name="Vic Viewer")
    for person, role in ((dev, "contributor"), (other, "contributor"), (viewer, "viewer")):
        ok(ws.admin.api.post(f"/api/projects/{pid}/members", {"user_id": person.id, "role": role}))
    ok(ws.admin.api.patch(f"/api/users/{dev.id}", {"hourly_rate": 1000}))
    ok(ws.admin.api.patch(f"/api/projects/{pid}", {"budget": 100000, "currency": "INR"}))
    feature = ok(ws.admin.api.post(f"/api/projects/{pid}/features", {"title": "Checkout", "stage": "proposed"}), 201)
    issue = ok(ws.admin.api.post("/api/issues", {"project_id": pid, "title": "Payment form", "feature_id": feature["id"]}), 201)
    loose = ok(ws.admin.api.post("/api/issues", {"project_id": pid, "title": "Server upgrade"}), 201)
    return pid, dev, other, viewer, feature, issue, loose


def test_time_on_a_feature_counts_with_its_issues(workspace):
    ws = workspace()
    pid, dev, other, viewer, feature, issue, loose = setup(ws)
    ok(dev.api.post(f"/api/issues/{issue['id']}/time", {"day": TODAY, "hours": 2}), 201)
    entry = ok(dev.api.post(f"/api/features/{feature['id']}/time", {"day": TODAY, "hours": 3, "note": "Design review"}), 201)
    assert entry["feature_id"] == feature["id"] and entry["issue_id"] is None
    ok(dev.api.post(f"/api/issues/{loose['id']}/time", {"day": TODAY, "hours": 1}), 201)

    summary = ok(ws.admin.api.get(f"/api/features/{feature['id']}/time"))
    assert (summary["direct_hours"], summary["issue_hours"], summary["total_hours"]) == (3, 2, 5)
    assert summary["cost"] == 5000 and summary["entries"][0]["note"] == "Design review"
    assert "cost" not in ok(dev.api.get(f"/api/features/{feature['id']}/time"))  # rates stay private

    budget = ok(ws.admin.api.get(f"/api/projects/{pid}/budget"))
    assert budget["hours"] == 6 and budget["cost"] == 6000 and budget["remaining"] == 94000
    rows = {(r["feature"] or {}).get("title"): r for r in budget["features"]}
    assert (rows["Checkout"]["hours"], rows["Checkout"]["direct_hours"], rows["Checkout"]["cost"]) == (5, 3, 5000)
    assert rows[None]["hours"] == 1  # work not linked to a feature

    sheet = ok(dev.api.get(f"/api/timesheet?start={TODAY}&end={TODAY}"))
    assert {(r["issue_title"], r["feature_title"]) for r in sheet} == {
        ("Payment form", None), (None, "Checkout"), ("Server upgrade", None)}
    workload = ok(ws.admin.api.get("/api/workload"))
    dana = next(p for p in workload["people"] if p["user"]["id"] == dev.id)
    assert sum(dana["logged"]) == 6


def test_who_can_log_and_remove_time_on_a_feature(workspace):
    ws = workspace()
    pid, dev, other, viewer, feature, issue, loose = setup(ws)
    fails(viewer.api.post(f"/api/features/{feature['id']}/time", {"day": TODAY, "hours": 1}), 403)
    tomorrow_plus = (date.today() + timedelta(days=3)).isoformat()
    fails(dev.api.post(f"/api/features/{feature['id']}/time", {"day": tomorrow_plus, "hours": 1}), 422)
    fails(dev.api.post(f"/api/features/{feature['id']}/time", {"day": TODAY, "hours": 25}), 422)
    entry = ok(dev.api.post(f"/api/features/{feature['id']}/time", {"day": TODAY, "hours": 1}), 201)
    fails(other.api.delete(f"/api/time/{entry['id']}"), 403)
    ok(dev.api.delete(f"/api/time/{entry['id']}"), 204)
    assert ok(dev.api.get(f"/api/features/{feature['id']}/time"))["total_hours"] == 0
    b = workspace()
    assert b.admin.api.get(f"/api/features/{feature['id']}/time").status_code in (403, 404)


def test_feature_time_needs_time_tracking(workspace, owner, plans):
    ws = workspace()
    project = ws.project("NT")
    feature = ok(ws.admin.api.post(f"/api/projects/{project['id']}/features", {"title": "F"}), 201)
    request = ok(ws.admin.api.post("/api/billing/requests", {"plan_id": plans["starter"]["id"], "seats": 5, "period": "monthly"}), 201)
    ok(owner.api.post(f"/api/platform/requests/{request['id']}/approve", {"note": ""}))
    fails(ws.admin.api.post(f"/api/features/{feature['id']}/time", {"day": TODAY, "hours": 1}), 402)
    fails(ws.admin.api.get(f"/api/features/{feature['id']}/time"), 402)
