"""Everyday project work: projects and roles, issues, workflow, fields, time, documents, the recycle bin and chat."""
from datetime import date

from conftest import fails, ok


def test_only_admins_and_managers_create_projects(workspace):
    ws = workspace()
    member = ws.add_person()
    lead = ws.add_person(role="manager")
    fails(member.api.post("/api/projects", {"name": "Nope", "key": "NOP"}), 403)
    project = ws.project("LED", by=lead)
    assert project["owner"]["id"] == lead.id and project["my_role"] == "owner"
    fails(ws.admin.api.post("/api/projects", {"name": "Dup", "key": "LED"}), 409)
    fails(ws.admin.api.post("/api/projects", {"name": "Bad", "key": "1X"}), 422)


def test_members_see_only_their_projects_and_sections(workspace):
    ws = workspace()
    viewer, outsider = ws.add_person(), ws.add_person()
    project = ws.project()
    fails(outsider.api.get(f"/api/projects/{project['id']}"), 404)
    ok(ws.admin.api.post(f"/api/projects/{project['id']}/members", {"user_id": viewer.id, "role": "viewer", "sections": ["issues"]}))
    seen = ok(viewer.api.get(f"/api/projects/{project['id']}"))
    assert seen["my_role"] == "viewer" and seen["can_edit"] is False and seen["sections"] == ["issues"]
    ok(viewer.api.get(f"/api/issues?project_id={project['id']}"))
    assert viewer.api.get(f"/api/projects/{project['id']}/features").status_code == 403
    fails(viewer.api.post("/api/issues", {"project_id": project["id"], "title": "x"}), 403)
    assert [p["id"] for p in ok(outsider.api.get("/api/projects"))] == []


def test_member_roles_include_manager_and_tester(workspace):
    ws = workspace()
    a, b = ws.add_person(), ws.add_person()
    project = ws.project()
    for person, role in ((a, "manager"), (b, "tester")):
        ok(ws.admin.api.post(f"/api/projects/{project['id']}/members", {"user_id": person.id, "role": role}))
    roles = {m["id"]: m["role"] for m in ok(ws.admin.api.get(f"/api/projects/{project['id']}"))["members"]}
    assert roles[a.id] == "manager" and roles[b.id] == "tester"
    fails(ws.admin.api.post(f"/api/projects/{project['id']}/members", {"user_id": a.id, "role": "boss"}), 422)
    fails(b.api.post(f"/api/projects/{project['id']}/members", {"user_id": a.id, "role": "viewer"}), 403)


def test_issue_lifecycle_with_comments_and_assignment(workspace):
    ws = workspace()
    dev = ws.add_person()
    project = ws.project("ISS")
    ok(ws.admin.api.post(f"/api/projects/{project['id']}/members", {"user_id": dev.id, "role": "contributor"}))
    issue = ok(ws.admin.api.post("/api/issues", {"project_id": project["id"], "title": "Fix login", "type": "bug", "priority": "high", "assignee_id": dev.id, "due_date": date.today().isoformat()}), 201)
    assert issue["key"] == "ISS-1" and issue["status"] == "todo"
    assert any("Fix login" in n["message"] for n in ok(dev.api.get("/api/notifications"))["updates"])
    ok(dev.api.post(f"/api/issues/{issue['id']}/comments", {"body": "On it"}), 201)
    done = ok(dev.api.patch(f"/api/issues/{issue['id']}", {"status": "done"}))
    assert done["status"] == "done" and done["completed_at"]
    fails(dev.api.patch(f"/api/issues/{issue['id']}", {"status": "no-such-status"}), 422)
    detail = ok(ws.admin.api.get(f"/api/issues/{issue['id']}"))
    assert [c["body"] for c in detail["comments"]] == ["On it"]
    assert ok(ws.admin.api.get(f"/api/projects/{project['id']}"))["done_count"] == 1


def test_custom_workflow_and_fields(workspace):
    ws = workspace()
    project = ws.project()
    workflow = ok(ws.admin.api.put(f"/api/projects/{project['id']}/workflow", {"statuses": [
        {"key": "todo", "label": "To do", "color": "#3b82f6"},
        {"label": "Waiting for client", "color": "#f59e0b"},
        {"key": "done", "label": "Done", "color": "#22c55e"},
    ]}))
    keys = [s["key"] for s in workflow["statuses"]]
    assert keys[0] == "todo" and keys[-1] == "done" and len(keys) == 3
    issue = ok(ws.admin.api.post("/api/issues", {"project_id": project["id"], "title": "x", "status": keys[1]}), 201)
    assert issue["status"] == keys[1]
    field = ok(ws.admin.api.post(f"/api/projects/{project['id']}/fields", {"name": "Customer", "type": "select", "options": ["Acme", "Globex"]}), 201)
    updated = ok(ws.admin.api.patch(f"/api/issues/{issue['id']}", {"custom": {str(field["id"]): "Acme"}}))
    assert updated["custom"][str(field["id"])] == "Acme"


def test_time_tracking_and_timesheet(workspace):
    ws = workspace()
    project = ws.project()
    issue = ok(ws.admin.api.post("/api/issues", {"project_id": project["id"], "title": "Work", "estimate_hours": 4}), 201)
    today = date.today().isoformat()
    entry = ok(ws.admin.api.post(f"/api/issues/{issue['id']}/time", {"day": today, "hours": 1.5, "note": "first pass"}), 201)
    fails(ws.admin.api.post(f"/api/issues/{issue['id']}/time", {"day": today, "hours": 30}), 422)
    sheet = ok(ws.admin.api.get(f"/api/timesheet?start={today}&end={today}"))
    assert "1.5" in str(sheet)
    ok(ws.admin.api.delete(f"/api/time/{entry['id']}"), 204)


def test_documents_and_risks(workspace):
    ws = workspace()
    project = ws.project()
    doc = ok(ws.admin.api.post(f"/api/projects/{project['id']}/documents", {"title": "Spec", "content": "# Goals"}), 201)
    assert ok(ws.admin.api.patch(f"/api/documents/{doc['id']}", {"content": "# Goals\n- fast"}))["content"].endswith("fast")
    risk = ok(ws.admin.api.post(f"/api/projects/{project['id']}/risks", {"title": "Vendor late", "probability": "high", "impact": "high"}), 201)
    assert risk["severity"] == "high"


def test_recycle_bin_restores_deleted_work(workspace):
    ws = workspace()
    project = ws.project()
    issue = ok(ws.admin.api.post("/api/issues", {"project_id": project["id"], "title": "Oops"}), 201)
    ok(ws.admin.api.delete(f"/api/issues/{issue['id']}"), 204)
    fails(ws.admin.api.get(f"/api/issues/{issue['id']}"), 404)
    trash = ok(ws.admin.api.get("/api/trash"))
    item = next(i for i in (trash if isinstance(trash, list) else trash["items"]) if i["title"].endswith("Oops") or i.get("id") == issue["id"])
    ok(ws.admin.api.post(f"/api/trash/{item['kind']}/{item['id']}/restore"))
    assert ok(ws.admin.api.get(f"/api/issues/{issue['id']}"))["title"] == "Oops"


def test_milestones_and_releases(workspace):
    ws = workspace()
    project = ws.project()
    ok(ws.admin.api.patch(f"/api/projects/{project['id']}", {"signoff_required": False}))
    milestone = ok(ws.admin.api.post(f"/api/projects/{project['id']}/milestones", {"name": "v1", "start_date": "2026-01-01", "due_date": "2026-02-01"}), 201)
    fails(ws.admin.api.post(f"/api/projects/{project['id']}/milestones", {"name": "bad", "start_date": "2026-02-01", "due_date": "2026-01-01"}), 422)
    assert ok(ws.admin.api.patch(f"/api/milestones/{milestone['id']}", {"status": "closed"}))["status"] == "closed"
    feature = ok(ws.admin.api.post(f"/api/projects/{project['id']}/features", {"title": "Checkout", "stage": "deployment"}), 201)
    release = ok(ws.admin.api.post(f"/api/projects/{project['id']}/releases", {"version": "1.0", "feature_ids": [feature["id"]]}), 201)
    ok(ws.admin.api.patch(f"/api/releases/{release['id']}", {"status": "deployed"}))
    # Without the sign-off rule, deploying to production releases the features.
    assert ok(ws.admin.api.get(f"/api/features/{feature['id']}"))["stage"] == "released"


def test_direct_chat_between_colleagues(workspace):
    ws = workspace()
    friend = ws.add_person()
    conversation = ok(ws.admin.api.post("/api/chat/direct", {"user_id": friend.id}))
    ok(ws.admin.api.post(f"/api/chat/conversations/{conversation['id']}/messages", {"body": "Hello!"}), 201)
    assert ok(friend.api.get("/api/chat/unread"))["count"] == 1
    messages = ok(friend.api.get(f"/api/chat/conversations/{conversation['id']}/messages"))
    assert "Hello!" in str(messages)
    assert ok(friend.api.get("/api/chat/unread"))["count"] == 0
    stranger = ws.add_person()
    assert stranger.api.get(f"/api/chat/conversations/{conversation['id']}/messages").status_code in (403, 404)


def test_dashboard_and_schedule_respond(workspace):
    ws = workspace()
    ok(ws.admin.api.get("/api/dashboard"))
    ok(ws.admin.api.get(f"/api/schedule?start={date.today().isoformat()}&end={date.today().isoformat()}"))
    ok(ws.admin.api.get("/api/roadmap"))
