"""Test management, and read-only client links with client feedback."""
from conftest import fails, ok


def setup_project(ws):
    project = ws.project("QA")
    tester = ws.add_person(full_name="Tia Tester")
    ok(ws.admin.api.post(f"/api/projects/{project['id']}/members", {"user_id": tester.id, "role": "tester"}))
    feature = ok(ws.admin.api.post(f"/api/projects/{project['id']}/features", {"title": "Login", "stage": "proposed", "owner_id": ws.admin.id}), 201)
    return project, tester, feature


# ───────────── Test cases ─────────────


def test_test_cases_runs_and_bugs(workspace):
    ws = workspace()
    project, tester, feature = setup_project(ws)
    pid = project["id"]
    passing = ok(tester.api.post(f"/api/projects/{pid}/tests", {"title": "Valid login works", "steps": "1. open\n2. sign in", "expected": "Dashboard", "feature_id": feature["id"]}), 201)
    failing = ok(tester.api.post(f"/api/projects/{pid}/tests", {"title": "Wrong password rejected", "feature_id": feature["id"]}), 201)
    assert passing["status"] == ""

    ok(tester.api.post(f"/api/tests/{passing['id']}/results", {"status": "passed"}))
    result = ok(tester.api.post(f"/api/tests/{failing['id']}/results", {"status": "failed", "note": "It let me in", "raise_bug": True}))
    assert result["status"] == "failed" and result["bug_issue_id"]
    bug = ok(ws.admin.api.get(f"/api/issues/{result['bug_issue_id']}"))
    assert bug["type"] == "bug" and bug["assignee"]["id"] == ws.admin.id and "It let me in" in bug["description"]
    assert any("raised a bug" in n["message"] for n in ok(ws.admin.api.get("/api/notifications"))["updates"])

    summary = ok(tester.api.get(f"/api/projects/{pid}/tests"))["summary"]
    assert summary == {"total": 2, "passed": 1, "failed": 1, "blocked": 0, "not_run": 0}
    assert len(ok(tester.api.get(f"/api/tests/{failing['id']}"))["results"]) == 1

    # Changing what is tested sets it back to "not run".
    ok(tester.api.patch(f"/api/tests/{passing['id']}", {"title": "Valid login works", "steps": "new steps", "expected": "Dashboard", "feature_id": feature["id"]}))
    assert ok(tester.api.get(f"/api/tests/{passing['id']}"))["status"] == ""
    ok(tester.api.post(f"/api/projects/{pid}/tests/reset"), 204)
    assert ok(tester.api.get(f"/api/projects/{pid}/tests"))["summary"]["not_run"] == 2
    fails(tester.api.post(f"/api/projects/{pid}/tests", {"title": "x", "feature_id": 999999}), 422)


def test_tests_are_private_to_the_workspace(workspace):
    a, b = workspace(), workspace()
    project, tester, feature = setup_project(a)
    case = ok(tester.api.post(f"/api/projects/{project['id']}/tests", {"title": "Secret test"}), 201)
    assert b.admin.api.get(f"/api/tests/{case['id']}").status_code in (403, 404)
    assert b.admin.api.post(f"/api/tests/{case['id']}/results", {"status": "passed"}).status_code in (403, 404)


# ───────────── Client links and feedback ─────────────


def make_link(ws, project, **extra):
    return ok(ws.admin.api.post(f"/api/projects/{project['id']}/share-links", {"label": "Client", "sections": ["milestones", "features"], **extra}), 201)


def test_share_link_shows_progress_without_internal_details(workspace, anon):
    ws = workspace()
    project, tester, feature = setup_project(ws)
    fails(tester.api.post(f"/api/projects/{project['id']}/share-links", {"label": "x"}), 403)
    link = make_link(ws, project)
    page = ok(anon.get(f"/api/public/share/{link['token']}"))
    assert page["project"]["name"] == project["name"] and page["features"][0]["title"] == "Login"
    assert "releases" not in page and "issues" not in page
    assert ws.username not in str(page) and "Tia Tester" not in str(page)
    assert ok(ws.admin.api.get(f"/api/projects/{project['id']}/share-links"))[0]["views"] == 1
    ok(ws.admin.api.delete(f"/api/share-links/{link['id']}"), 204)
    fails(anon.get(f"/api/public/share/{link['token']}"), 404)
    fails(anon.get("/api/public/share/not-a-real-token"), 404)


def test_clients_comment_and_approve_and_the_team_replies(workspace, anon):
    ws = workspace()
    project, tester, feature = setup_project(ws)
    link = make_link(ws, project)
    token = link["token"]
    approval = ok(anon.post(f"/api/public/share/{token}/feedback", {"name": "Carl Client", "body": "Looks great", "kind": "approval", "target_type": "feature", "target_id": feature["id"]}), 201)
    assert approval["target_name"] == "Login"
    fails(anon.post(f"/api/public/share/{token}/feedback", {"name": "Carl", "body": ""}), 422)
    fails(anon.post(f"/api/public/share/{token}/feedback", {"name": "Carl", "body": "x", "target_type": "milestone", "target_id": 999999}), 422)

    rows = ok(tester.api.get(f"/api/projects/{project['id']}/feedback"))
    assert [r["author"] for r in rows] == ["Carl Client"]
    fails(tester.api.patch(f"/api/feedback/{rows[0]['id']}", {"reply": "hi"}), 403)
    ok(ws.admin.api.patch(f"/api/feedback/{rows[0]['id']}", {"reply": "Thank you!", "resolved": True}))
    public = ok(anon.get(f"/api/public/share/{token}/feedback"))
    assert public["items"][0]["reply"] == "Thank you!" and ws.username not in str(public)
    assert any("Client Carl Client" in n["message"] for n in ok(ws.admin.api.get("/api/notifications"))["updates"])


def test_feedback_can_be_switched_off_and_is_rate_limited(workspace, anon):
    ws = workspace()
    project, _, _ = setup_project(ws)
    closed = make_link(ws, project, allow_feedback=False)
    fails(anon.post(f"/api/public/share/{closed['token']}/feedback", {"name": "C", "body": "hello"}), 403)
    open_link = make_link(ws, project)
    for n in range(20):
        ok(anon.post(f"/api/public/share/{open_link['token']}/feedback", {"name": "C", "body": f"message {n}"}), 201)
    fails(anon.post(f"/api/public/share/{open_link['token']}/feedback", {"name": "C", "body": "one too many"}), 429)
